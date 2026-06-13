import { Layout } from "../layout.tsx";
import type { ClientRow } from "../../oauth/router.ts";

function hostOf(uris: string): string {
  try {
    return new URL((JSON.parse(uris) as string[])[0] ?? "").host;
  } catch {
    return "unknown";
  }
}

export function ConsentPage(props: { client: ClientRow; params: Record<string, string> }) {
  const { client, params } = props;
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "resource", "scope"];
  return (
    <Layout title="Authorize" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-base-700 bg-base-900 p-8">
        <div class="mb-6 flex items-center gap-3">
          <img src="/assets/logo.svg" alt="" class="h-8 w-8" />
          <h1 class="text-lg font-semibold">Authorize access</h1>
        </div>
        <p class="mb-4 text-sm text-text-muted">
          <span class="font-semibold text-text">{client.client_name}</span> wants to access your Azure DevOps
          connections through this server (redirects to <span class="font-mono">{hostOf(client.redirect_uris)}</span>).
        </p>
        <p class="mb-6 text-sm text-text-muted">It will act as you and can call tools on every connection you have configured.</p>
        <form method="post" action="/oauth/consent" class="flex gap-3">
          {hidden.map((k) => (params[k] ? <input type="hidden" name={k} value={params[k]} /> : null))}
          <button name="decision" value="deny" class="flex-1 rounded-md border border-base-600 px-4 py-2 text-sm hover:bg-base-800">
            Deny
          </button>
          <button name="decision" value="approve" class="flex-1 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
            Approve
          </button>
        </form>
      </div>
    </Layout>
  );
}

export function OAuthErrorPage(props: { message: string }) {
  return (
    <Layout title="Authorization error" nav={false}>
      <div class="mx-auto mt-24 max-w-md rounded-lg border border-danger/40 bg-base-900 p-8">
        <h1 class="mb-3 text-lg font-semibold text-danger">Authorization error</h1>
        <p class="text-sm text-text-muted">{props.message}</p>
      </div>
    </Layout>
  );
}
