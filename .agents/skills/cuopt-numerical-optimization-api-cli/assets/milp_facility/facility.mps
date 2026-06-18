NAME          FACILITY
ROWS
 N  COST
 G  DEMAND1
 L  CAP1
 L  CAP2
COLUMNS
    MARKER    'MARKER'         'INTORG'
    OPEN1     COST             100.0
    OPEN1     CAP1             -50.0
    OPEN2     COST             150.0
    OPEN2     CAP2             -70.0
    MARKER    'MARKER'         'INTEND'
    SHIP11    COST               5.0
    SHIP11    DEMAND1            1.0
    SHIP11    CAP1               1.0
    SHIP21    COST               7.0
    SHIP21    DEMAND1            1.0
    SHIP21    CAP2               1.0
RHS
    RHS1      DEMAND1           30.0
BOUNDS
 BV BND1      OPEN1
 BV BND1      OPEN2
 LO BND1      SHIP11             0.0
 LO BND1      SHIP21             0.0
ENDATA
