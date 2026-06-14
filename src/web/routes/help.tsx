import { Layout, Card } from "../layout.tsx";

/**
 * Public help / "what is this" page. Renders with the full app nav when the
 * visitor has a session, and with a lightweight sign-in header when they don't —
 * so the same explanation is reachable logged in or out.
 */
export function HelpPage(props: { loggedIn: boolean; userName?: string }) {
  return (
    <Layout title="Help" activeNav="/help" nav={props.loggedIn} userName={props.userName}>
      <div class={props.loggedIn ? "" : "mx-auto max-w-3xl px-6 py-10"}>
        {!props.loggedIn ? <PublicHeader /> : null}

        <div class="space-y-6">
          <div>
            <h1 class="text-2xl font-semibold">What is this?</h1>
            <p class="mt-3 text-sm leading-relaxed text-text-muted">
              This is a self-hosted gateway that puts <strong class="text-text">Azure DevOps</strong> in front of
              your AI tools. Microsoft ships an official{" "}
              <a href="https://github.com/microsoft/azure-devops-mcp" class="text-accent hover:underline">
                Azure DevOps MCP server
              </a>
              , but it's built for one person on one machine: a single token, a single organization, talking over a
              local pipe. This service wraps that server and exposes it as a proper{" "}
              <strong class="text-text">authenticated endpoint on the internet</strong> that many people can share —
              each with their own private set of Azure DevOps connections.
            </p>
          </div>

          <Card title="What it does">
            <ul class="space-y-2 text-sm text-text-muted">
              <li>
                • Gives every account its own <strong class="text-text">isolated</strong> Azure DevOps connections —
                your token is never reachable by anyone else.
              </li>
              <li>
                • Speaks the <span class="font-mono">Model Context Protocol</span> (MCP), so MCP-aware clients like
                Claude can call Azure DevOps tools (work items, repos, pipelines, and more).
              </li>
              <li>
                • Stores your Azure DevOps personal access token <strong class="text-text">encrypted at rest</strong>{" "}
                and decrypts it only to talk to Azure DevOps on your behalf.
              </li>
              <li>
                • Keeps an <strong class="text-text">audit log</strong> of the calls made through your account, and
                tracks the upstream Microsoft server, upgrading it automatically in the background.
              </li>
            </ul>
          </Card>

          <Card title="Getting started">
            <ol class="space-y-3 text-sm text-text-muted">
              <li>
                <span class="font-medium text-text">1. Create an account.</span> Registration is open — sign up with a{" "}
                <strong class="text-text">passkey</strong> (Touch ID, Windows Hello, a security key, or your phone). No
                password to remember or leak.
              </li>
              <li>
                <span class="font-medium text-text">2. Add a connection.</span> Under{" "}
                {props.loggedIn ? (
                  <a href="/app/connections" class="text-accent hover:underline">Connections</a>
                ) : (
                  "Connections"
                )}
                , give it your Azure DevOps <strong class="text-text">organization</strong> and a{" "}
                <strong class="text-text">personal access token (PAT)</strong>. Use the narrowest scopes and shortest
                expiry you can — see the tips below.
              </li>
              <li>
                <span class="font-medium text-text">3. Connect your MCP client.</span> Two ways:
                <ul class="mt-2 ml-4 space-y-1">
                  <li>
                    • <strong class="text-text">OAuth</strong> — clients that support remote MCP (e.g. Claude) just
                    point at the endpoint and you authorize with your passkey.
                  </li>
                  <li>
                    • <strong class="text-text">API token</strong> — create one under{" "}
                    {props.loggedIn ? (
                      <a href="/app/tokens" class="text-accent hover:underline">Tokens</a>
                    ) : (
                      "Tokens"
                    )}{" "}
                    and send it as <span class="font-mono">Authorization: Bearer &lt;token&gt;</span>.
                  </li>
                </ul>
              </li>
              <li>
                <span class="font-medium text-text">4. Discover tools.</span> Tools are namespaced{" "}
                <span class="font-mono">&lt;slug&gt;__&lt;tool&gt;</span> per connection. Call{" "}
                <span class="font-mono">list_connections</span> from your client to see what's available.
              </li>
            </ol>
          </Card>

          <Card title="About your credentials">
            <p class="text-sm leading-relaxed text-text-muted">
              Your PAT is encrypted at rest and scoped to your account alone. Still, this is a personal, best-effort
              project, not a professionally operated service — so provision your PAT with the{" "}
              <strong class="text-text">narrowest scopes</strong> and <strong class="text-text">shortest expiry</strong>{" "}
              you can live with, and revoke it in Azure DevOps the moment you stop using it. Full details are in the{" "}
              <a href="/privacy" class="text-accent hover:underline">privacy &amp; disclaimer</a>.
            </p>
          </Card>

          <Card title="Run your own">
            <p class="text-sm leading-relaxed text-text-muted">
              Don't want to trust someone else's server with your Azure DevOps token? Fair. The whole thing is open
              source and ships as a single self-hosted container — clone it and run your own instance:
            </p>
            <p class="mt-3">
              <a href="https://github.com/jclement/azure-devops-mcp" class="font-mono text-sm text-accent hover:underline">
                github.com/jclement/azure-devops-mcp
              </a>
            </p>
          </Card>

          {!props.loggedIn ? (
            <div class="flex items-center gap-3 pt-2">
              <a href="/register" class="rounded-md bg-accent px-4 py-2 font-medium text-white hover:bg-accent-hover">
                Get started
              </a>
              <a href="/login" class="rounded-md border border-base-600 px-4 py-2 hover:bg-base-800">
                Sign in
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}

function PublicHeader() {
  return (
    <header class="mb-10 flex items-center justify-between">
      <a href="/" class="flex items-center gap-3">
        <img src="/assets/logo.svg" alt="" class="h-8 w-8" />
        <span class="font-semibold">Azure DevOps MCP</span>
      </a>
      <div class="flex items-center gap-3 text-sm">
        <a href="/login" class="rounded-md border border-base-600 px-3 py-1.5 hover:bg-base-800">Sign in</a>
        <a href="/register" class="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover">Get started</a>
      </div>
    </header>
  );
}
