import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { renderReviewPage } from "../scripts/autoboard/lib/review-page.mjs";

test("review page parses as a whole file and contains the render panel wiring", () => {
  execFileSync(process.execPath, ["--check", "scripts/autoboard/lib/review-page.mjs"], { stdio: "pipe" });
  const html = renderReviewPage();
  for (const marker of ["render-panel", "/api/render-status", "/api/render-cancel", "/api/pick-draft", "/api/approve-confirmed", "/api/instruction", "/api/item-note", "/api/render-options", "xhigh", "Transparent", "cost unavailable", "id=\"lightbox\"", "\"data-action\": \"draft\""]) {
    assert.ok(html.includes(marker), "page is missing " + marker);
  }
  const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
  assert.equal(script.includes("`"), false, "a backtick inside the embedded script would truncate the page");
  assert.match(script, /const completedList = last\.kind === "final" \? record\.finals : last\.kind === "confirm" \? record\.confirmed : record\.drafts/);
  assert.doesNotMatch(script, /const completed = \[\.\.\.record\.finals, \.\.\.record\.confirmed, \.\.\.record\.drafts\]\.at\(-1\)/);
});
