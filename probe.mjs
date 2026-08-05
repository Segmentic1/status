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
import { setTimeout as sleep } from "node:timers/promises";
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

// A hundred hours of hourly rollups, which is what the bar shows.
//
// A hundred bars is a little over four days. The window is deliberately short
// and the resolution deliberately fine: at one bar per day, twenty bad minutes
// disappeared inside a day that was otherwise green, and the bar that mattered
// most was the one nobody could see. At one bar per hour it is a mark of its
// own.
//
// The cost is at the other end. Four days is not long enough to answer "how
// were we last month", and the daily rollup that could answer it is gone. The
// incident list below is what carries anything older than this window.
const KEEP_HOURS = 100;

// Several samples per run, rather than one.
//
// The reason is that the run itself is not reliable. GitHub's schedule event
// is best effort and it is not a small effect here: in the three and a half
// hours after this repository was created, a cron asking for a run every ten
// minutes produced one. Every other measurement in the file had come from a
// push or from somebody pressing the button.
//
// A daily bar hid that completely, because a day with six checks in it was
// still one green bar. An hourly bar cannot hide it, which is how it was
// found.
//
// This does not fix the scheduler and nothing here can. What it fixes is the
// shape of an hour that does get a run: five samples over five minutes rather
// than a single instant, so the bar reports a stretch of time instead of a
// coin flip. An hour with no run at all stays grey, which is the truth.
//
// Five and 75 seconds are chosen against the ten minute slot: five minutes of
// sampling, and even in the worst case where every request runs to the full
// timeout, the run ends inside eight and a half minutes and is out of the way
// before the next one is due.
const SAMPLES = 5;
const SAMPLE_GAP_MS = 75_000;

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

/** This hour in Tehran, as YYYY-MM-DDTHH. */
function tehranHour(now = new Date()) {
  // timeZone does the offset including the half hour, which is the part that
  // hand-rolled arithmetic gets wrong: Tehran is +03:30, so an hour here
  // begins at half past the hour in UTC.
  //
  // Read from parts rather than from a formatted string, because a formatter
  // asked for a date and an hour together decides its own punctuation, and
  // hourCycle h23 is what keeps midnight as 00 rather than 24.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const at = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${at("year")}-${at("month")}-${at("day")}T${at("hour")}`;
}

async function loadHistory() {
  try {
    return JSON.parse(await readFile(HISTORY, "utf8"));
  } catch {
    // First run, or somebody deleted it. An empty history is a valid history:
    // the page renders a hundred grey hours and fills in from this one.
    return { hours: {}, incidents: [] };
  }
}

/**
 * Fold one round of measurements into the history.
 *
 * The hour is taken from the moment of the sample rather than from the moment
 * the run started. A run that begins at 20:56 and samples for five minutes
 * writes its last samples into hour 21, where they happened.
 */
function record(history, now, results) {
  // Roll each check into the hour, keeping counts rather than every sample.
  //
  // A hundred hours at thirty samples an hour is 3,000 measurements per
  // service, and keeping each one would make this file a database. Counts per
  // hour are four numbers and answer the only question the bar asks: how much
  // of that hour was bad.
  const thisHour = (history.hours[tehranHour(now)] ??= {});
  for (const [id, r] of Object.entries(results)) {
    const bucket = (thisHour[id] ??= { up: 0, slow: 0, down: 0, ms: 0, checks: 0 });
    bucket[r.state] += 1;
    bucket.checks += 1;
    // A running mean, so the hour's figure does not depend on keeping samples.
    bucket.ms = Math.round(bucket.ms + (r.ms - bucket.ms) / bucket.checks);
  }

  // Open or close an incident.
  //
  // Written by the probe rather than by hand, because an incident log that
  // depends on somebody remembering to write in it is empty on exactly the
  // days it should not be. A human can add a sentence to an entry afterwards;
  // the entry itself appears on its own.
  //
  // Per sample rather than per run, so a service that fails and recovers
  // inside one run leaves an entry with both a start and an end, instead of
  // being averaged into nothing by the time the run finishes.
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
}

async function main() {
  const history = await loadHistory();
  history.hours ??= {};
  history.incidents ??= [];

  // The daily rollup the page used to draw is dropped rather than kept beside
  // the hourly one. Every open tab re-fetches this file once a minute, and
  // ninety days of buckets nobody renders is tens of kilobytes on the wire
  // each time, on a page whose entire argument is that it asks for as little
  // as possible while somebody is trying to find out whether we are down.
  //
  // Nothing converts: a day that recorded six checks cannot be split into the
  // hours they happened in. The hourly window starts empty and fills.
  delete history.days;

  let results = {};
  let now = new Date();
  for (let sample = 1; sample <= SAMPLES; sample++) {
    if (sample > 1) await sleep(SAMPLE_GAP_MS);

    now = new Date();
    results = {};
    for (const service of SERVICES) {
      results[service.id] = await probe(service);
    }
    record(history, now, results);

    for (const [id, r] of Object.entries(results)) {
      console.log(`${sample}/${SAMPLES} ${id.padEnd(8)} ${r.state.padEnd(5)} ${String(r.ms).padStart(5)}ms ${r.detail ?? ""}`);
    }
  }

  // Trim to the window. Sorted lexically, which is the same as
  // chronologically for a fixed-width YYYY-MM-DDTHH and is the reason that
  // format is used here at all.
  const kept = Object.keys(history.hours).sort().slice(-KEEP_HOURS);
  history.hours = Object.fromEntries(kept.map((h) => [h, history.hours[h]]));

  // Twenty entries is more history than anybody scrolls, and the page has to
  // stay one screen.
  history.incidents = history.incidents.slice(0, 20);

  // The last sample, not the run as a whole. The dot at the top of the page
  // answers "is it up now", and the newest measurement is the only one that
  // can answer it.
  history.updated = now.toISOString();
  history.current = results;

  await writeFile(HISTORY, `${JSON.stringify(history, null, 1)}\n`);

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
