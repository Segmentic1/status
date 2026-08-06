//
// The thing that actually pulls the trigger.
//
// GitHub Actions has a `schedule` event and it does not work. Measured on this
// repository rather than assumed: over thirteen hours, a cron asking for a run
// every ten minutes produced seven runs instead of seventy eight. Every run
// that did happen landed within five minutes of a slot the cron had asked for,
// so the problem is not drift. GitHub silently drops about five of every six
// scheduled events. Nothing inside the repository can change that, which is
// why the trigger moved out here.
//
// This Worker is never visited by anybody. It wakes on its own cron, calls one
// GitHub endpoint, and goes back to sleep. That matters more than it sounds:
// workers.dev is filtered in Iran, and a Worker that nobody has to open is a
// Worker that filtering cannot break. Serving the status page itself from here
// would need the whole segmentic.net zone moved off ArvanCloud, which is a far
// larger change than this problem is worth.
//
// The token is a Worker secret, never a file in this repository. It is a
// fine-grained token scoped to Actions on this one public repository, so the
// worst a leak buys somebody is the right to make our own probe run more
// often. See trigger/README.md.
//
const REPO = "Segmentic1/status";
const WORKFLOW = "probe.yml";
const REF = "main";

export default {
  async scheduled(event, env, ctx) {
    if (!env.GITHUB_TOKEN) {
      // Deployed without the secret. Loud, because a trigger that quietly does
      // nothing is exactly the failure this Worker exists to end.
      console.error("no GITHUB_TOKEN: nothing was dispatched");
      return;
    }

    const url =
      `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub rejects an API request with no User-Agent, and a Worker does
        // not send one by default.
        "User-Agent": "segmentic-status-trigger",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    });

    // 204 with an empty body is success here.
    if (res.status === 204) {
      console.log(`dispatched ${WORKFLOW} on ${REF}`);
      return;
    }

    // The body carries GitHub's reason, and the reasons are worth reading:
    // 404 is usually a token that expired or lost its Actions permission
    // rather than a missing workflow, because a token without that permission
    // cannot see the workflow at all.
    console.error(`dispatch failed: HTTP ${res.status} ${await res.text()}`);
  },
};
