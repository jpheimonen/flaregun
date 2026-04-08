/**
 * Built-in default down page HTML template.
 *
 * Used when the user does not specify a custom `down_page` in their
 * flaregun.yml config. The domain name is injected into the page title
 * and body text so it is themed to the user's domain.
 *
 * The HTML is self-contained (no external resources), dark-themed, and
 * renders correctly in all modern browsers.
 */

/**
 * Generates the default down page HTML with the domain name injected.
 *
 * @param domain - The user's domain (e.g., "example.com")
 * @returns Complete HTML string for the down page
 */
export function defaultDownPageHtml(domain: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline \u2014 ${domain}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: 'Courier New', Courier, monospace;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      text-align: center;
    }
    .container {
      max-width: 480px;
      padding: 2rem;
    }
    h1 {
      font-size: 1.5rem;
      margin-bottom: 1rem;
      color: #fff;
      letter-spacing: 0.02em;
    }
    p {
      font-size: 1rem;
      line-height: 1.6;
      color: #888;
    }
    .subtitle {
      margin-top: 2rem;
      font-size: 0.85rem;
      color: #555;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>This site is currently offline</h1>
    <p>The local machine serving ${domain} is not running. There is nothing for you here \u2014 for now.</p>
    <p class="subtitle">Please try again later.</p>
  </div>
</body>
</html>`;
}
