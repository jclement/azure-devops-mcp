import { Layout } from "../layout.tsx";

/**
 * Public, unauthenticated privacy & disclaimer page. This is a personal,
 * best-effort hobby project — the copy is intentionally plain-spoken and makes
 * no legal guarantees about the safety of stored credentials.
 */
export function PrivacyPage() {
  return (
    <Layout title="Privacy & disclaimer" nav={false}>
      <div class="mx-auto max-w-2xl px-6 py-12">
        <a href="/" class="text-sm text-accent hover:underline">← Back</a>
        <h1 class="mt-4 text-2xl font-semibold">Privacy &amp; disclaimer</h1>
        <p class="mt-2 text-sm text-text-muted">Last updated 14 June 2026</p>

        <div class="mt-8 space-y-5 text-sm leading-relaxed text-text-muted">
          <p>
            This is a personal project run by{" "}
            <a href="https://owg.me" class="text-accent hover:underline">the OneWheelGeek</a>. It is a
            self-hosted, multi-user wrapper around Microsoft's Azure DevOps MCP server, offered for personal
            use. It is <strong class="text-text">not a commercial product</strong>, there is no company behind
            it, and there is no support obligation.
          </p>

          <h2 class="pt-2 text-base font-semibold text-text">What it stores</h2>
          <p>
            To talk to Azure DevOps on your behalf, this service stores the personal access token (PAT) you
            provide. PATs are encrypted at rest. The service also keeps your passkey credentials, a record of
            your connections and API tokens, and an audit log of the MCP calls made through your account so you
            can see what happened. It does not show your organizations, identities, or credentials to other
            users — each account is isolated.
          </p>

          <h2 class="pt-2 text-base font-semibold text-text">About your DevOps key</h2>
          <p>
            I'll do my best to protect your Azure DevOps PAT — it's encrypted and access is scoped to your
            account. But this is a hobby project, not a professionally operated, audited, or certified service.
            <strong class="text-text"> I make no legal guarantee that your credentials are safe.</strong>{" "}
            Accidents, bugs, outages, and breaches happen.
          </p>
          <p>
            Use this service at your own risk. Provision your Azure DevOps PAT with the{" "}
            <strong class="text-text">narrowest scopes</strong> and{" "}
            <strong class="text-text">shortest expiry</strong> you can live with, and revoke it in Azure DevOps
            the moment you stop using this service or suspect any problem. To the maximum extent permitted by
            law, this service is provided "as is", without warranty of any kind, and the operator accepts no
            liability for any loss or damage arising from its use.
          </p>

          <h2 class="pt-2 text-base font-semibold text-text">Questions</h2>
          <p>
            Reach out to <a href="https://owg.me" class="text-accent hover:underline">the OneWheelGeek</a>. If any
            of this is unacceptable for your situation, please don't store a PAT here.
          </p>
        </div>
      </div>
    </Layout>
  );
}
