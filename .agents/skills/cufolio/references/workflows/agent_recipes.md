# Reference cuFOLIO workflows for agent tasks

These helpers are intentionally small and direct. They show the API shapes that
agents should reuse when optimizing, tracing a frontier, backtesting, or running
monthly rebalancing with cuFOLIO. Copy the relevant function(s) and adapt only the
requested output — do not reimplement the package.

## Imports and dataset

```python
from __future__ import annotations

from pathlib import Path

import cvxpy as cp
import numpy as np
import pandas as pd

from cufolio import backtest, cvar_optimizer, cvar_utils, rebalance, utils
from cufolio.cvar_parameters import CvarParameters
from cufolio.portfolio import Portfolio
from cufolio.settings import KDESettings, ReturnsComputeSettings, ScenarioGenerationSettings

DEFAULT_DATASET = "data/stock_data/sp500.csv"
```

## Solver settings — require cuOpt (never substitute a CPU solver)

```python
def require_cuopt_solver() -> dict:
    """Return solver settings for cuOpt or fail clearly if cuOpt is unavailable."""
    if not hasattr(cp, "CUOPT"):
        raise RuntimeError(
            "cuOpt is required for this skill, but cvxpy does not expose cp.CUOPT. "
            "Install the CUDA/cuOpt-enabled cuFOLIO environment."
        )

    installed = {str(solver) for solver in cp.installed_solvers()}
    if str(cp.CUOPT) not in installed:
        raise RuntimeError(
            f"cuOpt is required for this skill, but installed solvers are {sorted(installed)}. "
            "Do not substitute CLARABEL, SCS, ECOS, or another CPU solver."
        )

    return {"solver": cp.CUOPT, "verbose": False, "solver_method": "PDLP"}
```

## CVaR parameters — fully invested (avoid the all-cash optimum)

```python
def fully_invested_params(
    *,
    w_min: float = 0.0,
    w_max: float = 1.0,
    risk_aversion: float = 1.0,
    confidence: float = 0.95,
) -> CvarParameters:
    """Use c_max=0.0 for ordinary portfolio builds so the result is not all cash."""
    return CvarParameters(
        w_min=w_min,
        w_max=w_max,
        c_min=0.0,
        c_max=0.0,
        risk_aversion=risk_aversion,
        confidence=confidence,
    )
```

## Load and validate prices

```python
def load_prices(
    path: str = DEFAULT_DATASET,
    *,
    tickers: list[str] | None = None,
    start: str | None = None,
    end: str | None = None,
    min_rows: int = 60,
) -> pd.DataFrame:
    """Load and validate date-indexed prices before return computation."""
    prices = utils.get_input_data(path)
    prices.index = pd.to_datetime(prices.index)

    if tickers:
        requested = [ticker.upper() for ticker in tickers]
        available = [ticker for ticker in requested if ticker in prices.columns]
        missing = sorted(set(requested) - set(available))
        if not available:
            raise ValueError(f"None of the requested tickers are present: {requested}")
        if missing:
            print(f"Missing tickers dropped: {missing}")
        prices = prices[available]

    if start or end:
        prices = prices.loc[start:end]

    prices = prices.apply(pd.to_numeric, errors="coerce").dropna(axis=1)
    if len(prices) < min_rows:
        raise ValueError(
            f"Need at least {min_rows} price rows after filtering; found {len(prices)}."
        )
    if prices.shape[1] == 0:
        raise ValueError("No numeric ticker columns remain after validation.")
    return prices
```

## Prepare returns — LOG returns + GPU KDE scenarios

```python
def prepare_returns(prices: pd.DataFrame, *, num_scen: int = 10_000) -> dict:
    """Compute LOG returns and GPU KDE scenarios in the flat returns_dict shape."""
    returns_dict = utils.calculate_returns(
        prices,
        regime_dict=None,
        returns_compute_settings=ReturnsComputeSettings(return_type="LOG"),
    )
    return cvar_utils.generate_cvar_data(
        returns_dict,
        ScenarioGenerationSettings(
            num_scen=num_scen,
            fit_type="kde",
            kde_settings=KDESettings(device="GPU"),
        ),
    )
```

## Optimize one Mean-CVaR allocation

```python
def optimize_portfolio(
    prices: pd.DataFrame,
    *,
    cvar_params: CvarParameters | None = None,
    solver_settings: dict | None = None,
) -> tuple[pd.Series, Portfolio, dict]:
    """Solve one Mean-CVaR allocation and return result row, portfolio, returns."""
    solver_settings = solver_settings or require_cuopt_solver()
    returns_dict = prepare_returns(prices)
    params = cvar_params or fully_invested_params()
    optimizer = cvar_optimizer.CVaR(returns_dict, params)
    result_row, portfolio = optimizer.solve_optimization_problem(
        solver_settings=solver_settings,
        print_results=False,
    )
    return result_row, portfolio, returns_dict
```

## Efficient frontier with a per-asset weights table

```python
def efficient_frontier_table(
    returns_dict: dict,
    cvar_params: CvarParameters,
    solver_settings: dict | None = None,
    *,
    ra_num: int = 25,
) -> tuple[pd.DataFrame, pd.DataFrame, object, object]:
    """Return the full frontier and a weights table with one row per risk level."""
    solver_settings = solver_settings or require_cuopt_solver()
    results_df, fig, ax = cvar_utils.create_efficient_frontier(
        returns_dict,
        cvar_params,
        solver_settings,
        ra_num=ra_num,
        show_plot=False,
        show_discretized_portfolios=False,
        benchmark_portfolios=False,
        print_portfolio_results=False,
    )
    weights_table = pd.DataFrame(results_df["weights"].tolist(), index=results_df.index)
    weights_table.insert(0, "risk_aversion", results_df["risk_aversion"])
    weights_table["cash"] = results_df["cash"].astype(float)
    return results_df, weights_table, fig, ax
```

## Backtest the optimized portfolio against equal weight

```python
def backtest_vs_equal_weight(
    returns_dict: dict,
    optimized_portfolio: Portfolio,
) -> pd.DataFrame:
    """Backtest an optimized Portfolio against equal weight over the same tickers."""
    tickers = list(returns_dict["tickers"])
    weights = np.asarray(optimized_portfolio.weights, dtype=float).flatten()
    cash = float(np.asarray(optimized_portfolio.cash).squeeze())
    optimized = Portfolio(
        name="cuOpt Optimal",
        tickers=tickers,
        weights=weights,
        cash=cash,
        time_range=optimized_portfolio.time_range,
    )
    equal_weight = Portfolio(
        name="Equal Weight",
        tickers=tickers,
        weights=np.ones(len(tickers)) / len(tickers),
        cash=0.0,
    )
    tester = backtest.portfolio_backtester(
        optimized,
        returns_dict,
        risk_free_rate=0.0,
        test_method="historical",
        benchmark_portfolios=[equal_weight],
    )
    backtest_results, _ax = tester.backtest_against_benchmarks(plot_returns=False)
    return backtest_results
```

## Monthly rebalancing

```python
def rebalance_monthly(
    prices: pd.DataFrame,
    *,
    solver_settings: dict | None = None,
    csv_path: str = "/tmp/cufolio_rebalance_prices.csv",
    look_back_window: int = 126,
    look_forward_window: int = 21,
) -> tuple[pd.DataFrame, list, pd.Series]:
    """Run the package rebalancer; it expects dataset_directory to be a CSV path."""
    solver_settings = solver_settings or require_cuopt_solver()
    path = Path(csv_path)
    prices.to_csv(path)

    if len(prices) <= look_back_window + look_forward_window:
        raise ValueError("Need more price history for the requested rebalance windows.")

    trading_start = str(prices.index[look_back_window].date())
    trading_end = str(prices.index[-look_forward_window].date())
    runner = rebalance.rebalance_portfolio(
        dataset_directory=str(path),
        returns_compute_settings=ReturnsComputeSettings(return_type="LOG"),
        scenario_generation_settings=ScenarioGenerationSettings(
            fit_type="kde",
            kde_settings=KDESettings(device="GPU"),
        ),
        trading_start=trading_start,
        trading_end=trading_end,
        look_forward_window=look_forward_window,
        look_back_window=look_back_window,
        cvar_params=fully_invested_params(),
        solver_settings=solver_settings,
        re_optimize_criteria={"type": "drift_from_optimal", "threshold": 0, "norm": 1},
        print_opt_result=False,
    )
    return runner.re_optimize(
        transaction_cost_factor=0.0,
        plot_results=False,
        plot_title="Monthly Rebalancing",
    )
```

## Minimal end-to-end report

```python
def build_report(path: str = DEFAULT_DATASET, tickers: list[str] | None = None) -> dict:
    """Minimal end-to-end report for optimization, frontier, and backtest tasks."""
    prices = load_prices(path, tickers=tickers)
    solver_settings = require_cuopt_solver()
    params = fully_invested_params()
    result_row, portfolio, returns_dict = optimize_portfolio(
        prices,
        cvar_params=params,
        solver_settings=solver_settings,
    )
    frontier, weights_table, _fig, _ax = efficient_frontier_table(
        returns_dict,
        params,
        solver_settings,
        ra_num=25,
    )
    backtest_results = backtest_vs_equal_weight(returns_dict, portfolio)
    allocation = (
        pd.Series(np.asarray(portfolio.weights, dtype=float).flatten(), index=portfolio.tickers)
        .sort_values(ascending=False)
        .rename("weight")
    )
    return {
        "result": result_row,
        "allocation": allocation,
        "cash": float(np.asarray(portfolio.cash).squeeze()),
        "frontier_rows": len(frontier),
        "frontier": frontier,
        "weights_table": weights_table,
        "backtest": backtest_results,
        "solver": "cuOpt GPU",
    }
```
