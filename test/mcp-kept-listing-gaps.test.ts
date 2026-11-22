import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { KeptListing, within } from "../src/mcp/kept-listing.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

const futureDeadline = () => Date.now() + 30_000;

describe("MCP kept listings and deadlines", { timeout: 5_000 }, () => {
  let keepAlive: ReturnType<typeof setInterval>;

  before(() => {
    // The deadline timers are unref'ed, so they cannot keep this test process alive.
    keepAlive = setInterval(() => {}, 1_000);
  });

  after(() => {
    clearInterval(keepAlive);
  });

  test("within returns a value that arrives before the deadline", async () => {
    const request = deferred<string>();
    const result = within(request.promise, 30_000, "cached");
    request.resolve("fresh");

    assert.deepEqual(await result, { value: "fresh", late: false });
  });

  test("within returns the fallback without marking a failed request as late", async () => {
    const request = Promise.reject<string>(new Error("workspace disconnected"));

    assert.deepEqual(await within(request, 30_000, "cached"), {
      value: "cached",
      late: false,
    });
  });

  test("within marks the fallback as late when the request outlasts the deadline", async () => {
    const request = deferred<string>();
    const result = within(request.promise, -1, "cached");

    assert.deepEqual(await result, { value: "cached", late: true });
    request.resolve("fresh");
  });

  test("concurrent first reads share a fetch and do not announce the initial answer", async () => {
    const request = deferred<string[]>();
    const fetchList = mock.fn(() => request.promise);
    const onChange = mock.fn();
    const listing = new KeptListing(fetchList, onChange);

    const first = listing.get(futureDeadline());
    const second = listing.get(futureDeadline());
    assert.equal(fetchList.mock.callCount(), 1);

    request.resolve(["search", "inspect"]);
    assert.deepEqual(await Promise.all([first, second]), [
      ["search", "inspect"],
      ["search", "inspect"],
    ]);
    assert.equal(onChange.mock.callCount(), 0);
  });

  test("a listing that arrives after the initial deadline is kept and announced once", async () => {
    const initial = deferred<string[]>();
    const background = deferred<string[]>();
    let reply = initial.promise;
    const fetchList = mock.fn(() => reply);
    const onChange = mock.fn();
    const listing = new KeptListing(fetchList, onChange);

    const first = listing.get(Date.now() - 1);
    const second = listing.get(Date.now() - 1);
    const inFlight = listing.refresh();

    assert.deepEqual(await Promise.all([first, second]), [[], []]);
    assert.equal(fetchList.mock.callCount(), 1);
    assert.equal(onChange.mock.callCount(), 0);

    initial.resolve(["search"]);
    assert.deepEqual(await inFlight, ["search"]);
    assert.equal(onChange.mock.callCount(), 1);

    reply = background.promise;
    // The next read serves the kept value while the new request is still pending.
    assert.deepEqual(await listing.get(futureDeadline()), ["search"]);
    const refreshing = listing.refresh();
    assert.equal(fetchList.mock.callCount(), 2);

    background.resolve(["search"]);
    assert.deepEqual(await refreshing, ["search"]);
    assert.equal(onChange.mock.callCount(), 1, "equal contents should not be announced again");
  });

  test("failed and unavailable refreshes preserve the last good listing, but an empty success replaces it", async () => {
    let fetch = (): Promise<string[] | null> => Promise.resolve(["search"]);
    const fetchList = mock.fn(() => fetch());
    const onChange = mock.fn();
    const listing = new KeptListing(fetchList, onChange);

    assert.deepEqual(await listing.get(futureDeadline()), ["search"]);

    fetch = () => Promise.reject(new Error("workspace disconnected"));
    assert.equal(await listing.refresh(), null);

    fetch = () => Promise.resolve(null);
    assert.equal(await listing.refresh(), null);
    assert.equal(onChange.mock.callCount(), 0);

    const replacement = deferred<string[]>();
    fetch = () => replacement.promise;
    assert.deepEqual(await listing.get(futureDeadline()), ["search"]);
    const refreshing = listing.refresh();
    assert.equal(fetchList.mock.callCount(), 4);

    const empty: string[] = [];
    replacement.resolve(empty);
    assert.strictEqual(await refreshing, empty);
    assert.equal(onChange.mock.callCount(), 1);

    assert.strictEqual(await listing.get(futureDeadline()), empty);
    assert.equal(fetchList.mock.callCount(), 5);
    assert.equal(onChange.mock.callCount(), 1);
  });
});
