import type { Child } from "hono/jsx";

export function Layout(props: { title?: string; children: Child; nav?: boolean; activeNav?: string; userName?: string }) {
  return (
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title ? `${props.title} · Azure DevOps MCP` : "Azure DevOps MCP"}</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <link rel="icon" href="/assets/logo.svg" type="image/svg+xml" />
        <script src="/assets/vendor/htmx.min.js" defer></script>
      </head>
      <body class="min-h-full">
        {props.nav !== false ? <Nav active={props.activeNav} userName={props.userName} /> : null}
        <main class={props.nav !== false ? "mx-auto max-w-6xl px-6 py-8" : ""}>{props.children}</main>
      </body>
    </html>
  );
}

const NAV_ITEMS = [
  ["/app", "Dashboard"],
  ["/app/connections", "Connections"],
  ["/app/tokens", "Tokens"],
  ["/app/clients", "Clients"],
  ["/app/activity", "Activity"],
  ["/app/account", "Account"],
  ["/help", "Help"],
] as const;

function Nav(props: { active?: string; userName?: string }) {
  return (
    <nav class="border-b border-base-700 bg-base-900">
      <div class="mx-auto flex max-w-6xl items-center gap-1 px-6">
        <a href="/app" class="mr-4 flex shrink-0 items-center gap-2 py-3 font-semibold whitespace-nowrap text-text">
          <img src="/assets/logo.svg" alt="" class="h-5 w-5" />
          Azure DevOps MCP
        </a>
        {NAV_ITEMS.map(([href, label]) => (
          <a
            href={href}
            class={`shrink-0 rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${
              props.active === href ? "bg-accent-muted/40 text-text" : "text-text-muted hover:text-text"
            }`}
          >
            {label}
          </a>
        ))}
        <div class="ml-auto flex shrink-0 items-center gap-3">
          {props.userName ? <span class="text-sm text-text-muted">{props.userName}</span> : null}
          <form method="post" action="/logout">
            <button type="submit" class="px-2 py-1.5 text-sm whitespace-nowrap text-text-muted hover:text-text">
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}

export function Card(props: { title?: string; children: Child }) {
  return (
    <section class="rounded-lg border border-base-700 bg-base-900 p-5">
      {props.title ? <h2 class="mb-3 text-base font-semibold">{props.title}</h2> : null}
      {props.children}
    </section>
  );
}

/** Relative-time formatter used across pages. */
export function ago(unix: number | null): string {
  if (!unix) return "never";
  const s = Math.floor(Date.now() / 1000) - unix;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
