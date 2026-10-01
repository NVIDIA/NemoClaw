// Cloudflare Worker: adds cross-origin isolation headers to all responses.
// CheerpX requires SharedArrayBuffer, which requires COOP/COEP headers.

export default {
  async fetch(request, env, ctx) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    
    newResponse.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    newResponse.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    
    return newResponse;
  },
};
