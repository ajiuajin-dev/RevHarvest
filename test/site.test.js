import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const indexUrl = new URL("../docs/index.html", import.meta.url);
const html = await readFile(indexUrl, "utf8");
const portfolioUrl = new URL("../docs/portfolio/index.html", import.meta.url);
const portfolioHtml = await readFile(portfolioUrl, "utf8");

test("static website has required metadata, navigation, and calls to action", () => {
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /name="description"/);
  assert.match(html, /href="#workflow"/);
  assert.match(html, /href="#features"/);
  assert.match(html, /href="#install"/);
  assert.match(html, /ajiuajin-dev\/RevHarvest/);
});

test("all local website assets referenced by the page exist", async () => {
  const references = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:https?:|mailto:)/.test(value));

  await Promise.all(references.map((reference) => access(new URL(reference, indexUrl))));
});

test("portfolio presents the resume content without publishing sensitive fields", () => {
  assert.match(portfolioHtml, /<html lang="zh-CN">/);
  assert.match(portfolioHtml, /刘金豪/);
  assert.match(portfolioHtml, /大连海事大学/);
  assert.match(portfolioHtml, /留记/);
  assert.match(portfolioHtml, /安卓在线音乐播放平台/);
  assert.match(portfolioHtml, /id="contact"/);
  assert.doesNotMatch(portfolioHtml, /19870686978/);
  assert.doesNotMatch(portfolioHtml, /政治面貌|家庭住址|户籍/);
});

test("all local portfolio assets referenced by the page exist", async () => {
  const references = [...portfolioHtml.matchAll(/(?:href|src)="([^"#]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:https?:|mailto:)/.test(value));

  await Promise.all(references.map((reference) => access(new URL(reference, portfolioUrl))));
});

test("GitHub Pages workflow publishes the docs directory", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  assert.match(workflow, /path: docs/);
});
