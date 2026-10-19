/**
 * Where the "Connect Cloudflare" panel goes on the account page. This placeholder only says whether the server counts
 * the account as connected; the Cloudflare connection's own panel (connect, choose an account, disconnect) takes its
 * place when it is wired in.
 */
export function CloudflareSlot({ status }: { status: "connected" | "not-connected" | "unknown" }) {
  return (
    <section className="ac-card ac-cloudflare" data-slot="connect-cloudflare">
      <h2 className="ac-h2">Your Cloudflare account</h2>
      <p className="ac-text">
        FireTrident is free. What your colonies cost runs on your own Cloudflare account: their repositories live in your Artifacts and their model calls run on your Workers AI, billed to you.
      </p>
      <p className="ac-text ac-strong">
        {status === "connected"
          ? "Connected."
          : status === "not-connected"
            ? "Not connected yet. Connect your Cloudflare account before you create a colony."
            : "Connecting a Cloudflare account is not available on this deployment yet."}
      </p>
    </section>
  );
}
