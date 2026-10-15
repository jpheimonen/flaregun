/**
 * A local stand-in for the Cloudflare API tokens pages, shaped like the real
 * flow: a login redirect, the token list, the template list, the template form,
 * the summary and the success page. Views change asynchronously, like the
 * dashboard's single-page app.
 */

export const FAKE_TOKEN = "Zx9_fakeBootstrapToken-0123456789abcdefGHIJ";
const TOKEN_ID = "0123456789abcdef0123456789abcdef";

const APP = `<!doctype html>
<html><body><div id="app"></div>
<script>
  const app = document.getElementById("app");
  window.__clicks = [];
  const later = (fn) => setTimeout(fn, 250);
  const views = {
    list: () => \`<h1>API Tokens</h1><p>No tokens yet.</p>
      <div><button id="create"><span>Create Token</span></button></div>\`,
    templates: () => \`<h1>Create API Token</h1><table>\${
      ["Edit zone DNS", "Read billing info", "Create Additional Tokens", "Read all resources"]
        .map((name, i) => \`<tr><td><div class="name">\${name}</div><div>Template \${i}</div></td>
          <td><button data-template="\${name}">Use template</button></td></tr>\`).join("")
    }</table><div><h2>Custom token</h2><button>Get started</button></div>\`,
    form: (name) => \`<h1>\${name}</h1><p>User - API Tokens - Edit</p>
      <button>Cancel</button><button id="continue">Continue to summary</button>\`,
    summary: () => \`<h1>Create Additional Tokens summary</h1>
      <button>← Edit token</button><button id="final">Create Token</button>\`,
    success: () => \`<p>Token \${"${TOKEN_ID}"} was successfully created</p>
      <input readonly value="${FAKE_TOKEN}">
      <pre>curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\\
     -H "Authorization: Bearer ${FAKE_TOKEN}"</pre>\`,
  };
  function show(view, arg) { app.innerHTML = views[view](arg); }
  app.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    window.__clicks.push(button.textContent.trim());
    if (button.id === "create") later(() => show("templates"));
    else if (button.dataset.template) later(() => show("form", button.dataset.template));
    else if (button.id === "continue") later(() => show("summary"));
    else if (button.id === "final") later(() => show("success"));
  });
  later(() => show("list"));
</script></body></html>`;

const LOGIN = `<!doctype html><html><body><h1>Log in to Cloudflare</h1>
<script>
  // Stands in for the person logging in.
  setTimeout(() => { document.cookie = "session=1; path=/"; location.href = "/profile/api-tokens"; }, 800);
</script></body></html>`;

const CHECK = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<p>Verifying you are human.</p>
<script>
  setTimeout(() => { document.cookie = "checked=1; path=/"; location.reload(); }, 800);
</script></body></html>`;

export function startFakeDashboard(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html" } });
      if (url.pathname === "/login") return html(LOGIN);
      if (url.pathname === "/profile/api-tokens") {
        const cookie = req.headers.get("cookie") ?? "";
        if (!cookie.includes("session=1")) {
          return Response.redirect(`${url.origin}/login`, 302);
        }
        // Like Cloudflare's "Just a moment..." check: shown once, then passed.
        if (!cookie.includes("checked=1")) return html(CHECK);
        return html(APP);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/profile/api-tokens`, stop: () => server.stop(true) };
}
