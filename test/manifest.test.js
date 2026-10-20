import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest uses MV3 and limits access to a user-activated tab", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("downloads"));
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
});

test("manifest does not request sensitive cookie or request interception permissions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const forbidden = ["cookies", "webRequest", "webRequestBlocking", "debugger", "<all_urls>"];
  for (const permission of forbidden) {
    assert.ok(!manifest.permissions.includes(permission), `unexpected permission: ${permission}`);
  }
});
