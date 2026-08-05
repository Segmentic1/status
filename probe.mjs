#!/usr/bin/env node
//
// The probe behind the status page.
//
// It runs on GitHub's runners, on a schedule, on infrastructure that has
// nothing to do with the infrastructure it measures. That separation is the
// entire point. A status page hosted next to the thing it reports on goes down
// with it and, at the moment somebody most needs it, serves nothing.
//
// It writes history.json next to itself. That file is the whole database.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HISTORY = join(HERE, "history.json");

// What a customer would call a separate thing that can break separately.
//
// Not one dot per container. Nobody outside the engineering team knows what a
// collector is, and a page that lists seven binaries is a page that tells its
// reader to go and learn somebody else's architecture before finding out
// whether their events are arriving.
const SERVICES = [
  {
    id: "ingest",
    url: "https://in.segmentic.net/v1/status",
    // The one that matters most and the one nobody thinks of first. If this is
    // down, events are being dropped on the floor at the customer's end and
    // nothing in their own logs says so.
    critical: true,
  },
  { id: "api", url: "https://api.segmentic.net/v1/status", critical: true },
  { id: "panel", url: "https://app.segmentic.net/", critical: false },
  { id: "site", url: "https://segmentic.net/", critical: false },
];

// A request that has not answered in ten seconds has failed, whatever it does
// afterwards. A customer's SDK gave up long before this.
const TIMEOUT_MS = 10_000;

// Slow is its own state, between up and down.
//
// A page with two colours has to call a service that answers in four seconds
// "up", which is true and useless. Most real incidents look like this before
// they look like anything else.
//
// The number is 3.5 seconds rather than the 2 it started as, and the reason is
// where this runs. The probe is outside Iran and the servers are inside it, so
// roughly a second of every measurement here is the path rather than the
// service. Measured on 2026-08-05, the same four URLs, same minute:
//
//   ingest   81-320ms from Tehran    1227-1697ms from a runner
//   api      49-236ms                1094-1171ms
//   panel    61-139ms                1050-1163ms
//   site    146-345ms                1003-1066ms
//
// At 2 seconds that left about 900ms of headroom above a floor nobody had
// measured, so ordinary jitter on the slowest of the four was reported as a
// degradation. It went orange on a service that was answering Iranian
// customers in a tenth of a second.
//
// 3.5 leaves about 2.5 seconds above the floor: still well inside what a
// person would call slow, and no longer tripped by the distance itself.
// Whoever changes this should re-measure first. The floor is a property of the
// network between two countries and it will not stay where it is.
const SLOW_MS = 3_500;

// Ninety days of daily rollups, which is what the bar shows.
const KEEP_DAYS = 90;

async function probe(service) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(service.url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "segmentic-status-probe" },
      cache: "no-store",
    });
    const ms = Date.now() - started;

    // 2xx and 3xx both count. The panel answers 307 to a signed-out probe,
    // which is the panel working correctly; treating a redirect as an outage
    // would have this page permanently red for a service that is fine.
    const ok = res.status >= 200 && res.status < 400;
    if (!ok) return { state: "down", ms, detail: `HTTP ${res.status}` };
    return { state: ms > SLOW_MS ? "slow" : "up", ms };
  } catch (err) {
    const ms = Date.now() - started;
    // A timeout and a refused connection are both "down" to a customer, and
    // the distinction belongs in the detail rather than in the colour.
    const detail = err?.name === "AbortError" ? "timeout" : String(err?.cause?.code ?? err?.message ?? err);
    return { state: "down", ms, detail };
  } finally {
    clearTimeout(timer);
  }
}

/** Today in Tehran, as YYYY-MM-DD. */
function tehranDay(now = new Date()) {
  // en-CA gives ISO order, and timeZone does the offset including the half
  // hour, which is the part that hand-rolled arithmetic gets wrong.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY, "utf8"));
  } catch {
    // First run, or somebody deleted it. An empty history is a valid history:
    // the page renders ninety grey days and fills in from today.
    return { days: {}, incidents: [] };
  }
}

async function main() {
  const now = new Date();
  const day = tehranDay(now);
  const history = await loadHistory();
  history.days ??= {};
  history.incidents ??= [];

  const results = {};
  for (const service of SERVICES) {
    results[service.id] = await probe(service);
  }

  // Roll each check into the day, keeping counts rather than every sample.
  //
  // Ninety days at one check a minute is 129,600 rows per service, which is a
  // database. Counts per day are four numbers and answer the only question the
  // bar asks: how much of that day was bad.
  const today = (history.days[day] ??= {});
  for (const [id, r] of Object.entries(results)) {
    const bucket = (today[id] ??= { up: 0, slow: 0, down: 0, ms: 0, checks: 0 });
    bucket[r.state] += 1;
    bucket.checks += 1;
    // A running mean, so the day's figure does not depend on keeping samples.
    bucket.ms = Math.round(bucket.ms + (r.ms - bucket.ms) / bucket.checks);
  }

  // Trim to the window. Sorted lexically, which is the same as chronologically
  // for YYYY-MM-DD and is the reason that format is used here at all.
  const kept = Object.keys(history.days).sort().slice(-KEEP_DAYS);
  history.days = Object.fromEntries(kept.map((d) => [d, history.days[d]]));

  // Open or close an incident.
  //
  // Written by the probe rather than by hand, because an incident log that
  // depends on somebody remembering to write in it is empty on exactly the
  // days it should not be. A human can add a sentence to an entry afterwards;
  // the entry itself appears on its own.
  for (const service of SERVICES) {
    const r = results[service.id];
    const open = history.incidents.find((i) => i.service === service.id && !i.ended);
    if (r.state === "down" && !open) {
      history.incidents.unshift({
        service: service.id,
        started: now.toISOString(),
        ended: null,
        detail: r.detail ?? "",
        note: "",
      });
    } else if (r.state !== "down" && open) {
      open.ended = now.toISOString();
    }
  }
  // Twenty entries is more history than anybody scrolls, and the page has to
  // stay one screen.
  history.incidents = history.incidents.slice(0, 20);

  history.updated = now.toISOString();
  history.current = results;

  await writeFile(HISTORY, `${JSON.stringify(history, null, 1)}\n`);

  for (const [id, r] of Object.entries(results)) {
    console.log(`${id.padEnd(8)} ${r.state.padEnd(5)} ${String(r.ms).padStart(5)}ms ${r.detail ?? ""}`);
  }

  // Exit zero even when something is down.
  //
  // A red run in Actions means "the probe failed", and the probe reporting an
  // outage correctly is the probe working. Conflating the two produces a
  // permanently failing workflow that everybody learns to ignore, which is how
  // the real failure gets missed.
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
