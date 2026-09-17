#!/usr/bin/env node
//
// Experiment: can a TypeSafe Noul pre-screen a reference photo from its
// metadata alone — before anyone downloads it or looks at it?
//
//   node scripts/experiments/typesafe/reference-screening.mjs [--baseline-only]
//
// Where this comes from: assembling 651 Belmont's image manifest meant
// reviewing 48 candidate URLs by eye on a contact sheet and rejecting 8. The
// expensive part is the looking. If a judgment over {product, required finish,
// URL, filename} catches the rejects that ARE encoded in metadata, the eyeball
// pass only has to cover what is left.
//
// Pre-registered hypothesis (written before the first run):
//   catchable from metadata  R1, R2 (vendor "generic art": a model number with
//                            no finish suffix, which is the chrome shot) and R4
//                            (a _Flute_ variant standing in for a flat field tile)
//   NOT catchable            R3, R6, R7, R8 (text baked into the picture) and
//                            R5 (a CDN placeholder card served at HTTP 200)
// A run that flags all 8 would mean the questions are firing on something other
// than the evidence, and a run that flags none of the 40 accepted references is
// as important as the recall number: a screen with false positives just moves
// the manual work rather than removing it.
//
// Scoring: recall over the 8 known rejects, false-positive rate over the 40
// accepted references, split by whether the defect is visible in metadata.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { ask, loadApiKey, MODEL } from "./client.mjs";

const MANIFEST = "scripts/autoboard/projects/651-belmont-images.json";
const PROJECT = "scripts/autoboard/projects/651-belmont.json";
const OUT_DIR = "artifacts/typesafe-experiments";

// The eight references rejected during the 651 Belmont review, with the reason
// and whether that reason is present in the metadata at all.
const REJECTED = [
  {
    id: "R1",
    imageKey: "kohler-K-T14420-4G-BN",
    url: "https://www.kbauthority.com/images/T/188/K-T14420-4G.jpg",
    reason: "chrome product shot offered for a Vibrant Brushed Nickel row",
    evidence: "metadata",
  },
  {
    id: "R2",
    imageKey: "kohler-K-22181-G-BL",
    url: "https://www.kbauthority.com/images/T/410/K-22181-G.jpg",
    reason: "chrome product shot offered for a Matte Black row",
    evidence: "metadata",
  },
  {
    id: "R3",
    imageKey: "kohler-K-14406-4-BL",
    url: "https://images.thdstatic.com/productImages/10be4a0a-c6a9-49d9-8e10-ace12132c48e/svn/matte-black-kohler-widespread-bathroom-faucets-k-14406-4-bl-1f_1000.jpg",
    reason: "dimension callouts printed on the image",
    evidence: "pixels",
  },
  {
    id: "R4",
    imageKey: "elm-grounded-alabaster-12x24",
    url: "https://cdn.prod.website-files.com/6508c8490fee3dfe75080d5e/68313647a51c5bd5e0c9a9c8_MILE_stone_Earthen_Alabaster_12x24_Flute_03.jpg",
    reason: "fluted relief variant offered for the plain flat field tile",
    evidence: "metadata",
  },
  {
    id: "R5",
    imageKey: "porcelanosa-metropolitan-grass",
    url: "https://media-prod.porcelanosa.com/media/catalog/product/1/0/100336793_01.jpg",
    reason: "CDN placeholder card (grey PORCELANOSA logo) served at HTTP 200",
    evidence: "pixels",
  },
  {
    id: "R6",
    imageKey: "kohler-K-14435-BL",
    url: "https://images.thdstatic.com/productImages/5a010ebc-7a29-4e68-ab56-7a271f4aeed0/svn/matte-black-towel-bars-k-14435-bl-e1_1000.jpg",
    reason: "\"Complete the Space\" marketing graphic with text",
    evidence: "pixels",
  },
  {
    id: "R7",
    imageKey: "kohler-K-14441-BN",
    url: "https://images.thdstatic.com/productImages/288c92ef-cd89-4835-a19f-275396f913b1/svn/vibrant-brushed-nickel-kohler-towel-rings-k-14441-bn-e1_1000.jpg",
    reason: "\"What's in the Box\" graphic with text",
    evidence: "pixels",
  },
  {
    id: "R8",
    imageKey: "kohler-K-14444-BN",
    url: "https://images.thdstatic.com/productImages/34f93677-1216-4dcb-b844-203abd3a5b74/svn/vibrant-brushed-nickel-kohler-toilet-paper-holders-k-14444-bn-e1_1000.jpg",
    reason: "brand image of a chrome sink, not the product",
    evidence: "pixels",
  },
];

const FINISH_WORDS = {
  BN: "Vibrant Brushed Nickel (Kohler finish suffix BN)",
  BL: "Matte Black (Kohler finish suffix BL)",
};

function requiredFinish(sku) {
  const suffix = /-(BN|BL)$/.exec(sku ?? "")?.[1];
  return suffix ? FINISH_WORDS[suffix] : "";
}

function candidateMeta(url, file = {}) {
  const parsed = new URL(url);
  return {
    url,
    host: parsed.hostname,
    filename: path.basename(parsed.pathname),
    width: file.width ?? null,
    height: file.height ?? null,
    bytes: file.bytes ?? null,
  };
}

function questionsFor(candidates) {
  const questions = {};
  candidates.forEach((candidate, index) => {
    const at = `candidates[${index}]`;
    questions[`finish_${candidate.id}`] = {
      type: "noul",
      instructions: `\`product\` names the exact product and, where it has one, the finish that product must be shown in. Does the file at \`${at}\` appear to show that product in that finish?`,
      criteria: {
        true: "The host, path and filename are consistent with this exact product in the required finish.",
        false: "The filename names a different finish, or carries only the bare model number with no finish suffix — vendors serve that as the default chrome artwork.",
      },
    };
    questions[`variant_${candidate.id}`] = {
      type: "noul",
      instructions: `\`product.spec\` describes the exact format and surface that was specified. Does the file at \`${at}\` appear to show that same format and surface, rather than a different size, shape or surface treatment from the same collection?`,
      criteria: {
        true: "Nothing in the filename contradicts the specified format and surface.",
        false: "The filename names a different variant — for example a fluted or relief version where a plain flat face was specified, or a hexagon sheet where a square mosaic was specified.",
      },
    };
  });
  return questions;
}

function stateFor(product, candidates) {
  return {
    product: {
      name: product.name,
      sku: product.sku,
      requiredFinish: requiredFinish(product.sku),
      spec: product.spec ?? "",
      vendorPage: product.vendorPage ?? "",
    },
    note: "The candidates are images a scraper proposed as reference photography for this product. Only their metadata is available; the pictures themselves have not been opened.",
    candidates: candidates.map(({ id, ...meta }) => ({ id, ...meta })),
  };
}

async function main() {
  const { values } = parseArgs({ options: { "baseline-only": { type: "boolean" }, threshold: { type: "string", default: "0.5" } } });
  const threshold = Number(values.threshold);
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const definition = JSON.parse(await readFile(PROJECT, "utf8"));

  const specFor = new Map();
  for (const room of definition.rooms) {
    for (const item of room.items) {
      if (item.imageKey && !specFor.has(item.imageKey)) specFor.set(item.imageKey, item.spec ?? "");
    }
  }

  // One request per product: its accepted references plus any rejected
  // candidate recorded for it. Both classes are judged by the same questions.
  const cases = [];
  for (const [imageKey, entry] of Object.entries(manifest.images)) {
    const accepted = entry.files.map((file, index) => ({
      id: `A${index + 1}`,
      label: "accept",
      ...candidateMeta(file.url, file),
    }));
    const rejected = REJECTED.filter((reject) => reject.imageKey === imageKey).map((reject) => ({
      id: reject.id,
      label: "reject",
      reason: reject.reason,
      evidence: reject.evidence,
      ...candidateMeta(reject.url),
    }));
    if (!accepted.length && !rejected.length) continue;
    cases.push({
      imageKey,
      product: { name: entry.product, sku: entry.sku, vendorPage: entry.vendorPage, spec: specFor.get(imageKey) ?? "" },
      candidates: [...accepted, ...rejected],
    });
  }

  const results = { model: MODEL, ranAt: new Date().toISOString(), threshold, cases: [], usage: { input_tokens: 0, output_tokens: 0, requests: 0, latencyMs: 0 } };
  let apiKey = null;
  if (!values["baseline-only"]) {
    try {
      apiKey = loadApiKey();
    } catch (error) {
      console.error(`\n${error.message}\n`);
    }
  }

  const counts = { accept: 0, reject: 0, flaggedAccept: 0, flaggedReject: 0, byEvidence: { metadata: { total: 0, flagged: 0 }, pixels: { total: 0, flagged: 0 } } };
  for (const testCase of cases) {
    for (const candidate of testCase.candidates) {
      counts[candidate.label] += 1;
      if (candidate.label === "reject") counts.byEvidence[candidate.evidence].total += 1;
    }
    if (!apiKey) continue;
    const response = await ask({
      state: stateFor(testCase.product, testCase.candidates),
      questions: questionsFor(testCase.candidates),
      apiKey,
    });
    const judged = testCase.candidates.map((candidate) => {
      const finish = response.answers?.[`finish_${candidate.id}`]?.noul ?? null;
      const variant = response.answers?.[`variant_${candidate.id}`]?.noul ?? null;
      // Code owns the policy: flag when either judgment falls below the bar.
      const flagged = (finish !== null && finish < threshold) || (variant !== null && variant < threshold);
      if (flagged) {
        if (candidate.label === "reject") {
          counts.flaggedReject += 1;
          counts.byEvidence[candidate.evidence].flagged += 1;
        } else {
          counts.flaggedAccept += 1;
        }
      }
      return { id: candidate.id, label: candidate.label, evidence: candidate.evidence ?? "", filename: candidate.filename, finish, variant, flagged, reason: candidate.reason ?? "" };
    });
    results.cases.push({ imageKey: testCase.imageKey, sku: testCase.product.sku, judged });
    results.usage.input_tokens += response.usage?.input_tokens ?? 0;
    results.usage.output_tokens += response.usage?.output_tokens ?? 0;
    results.usage.latencyMs += response.latencyMs;
    results.usage.requests += 1;
  }
  results.counts = counts;

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, "reference-screening.json");
  await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`, "utf8");

  console.log(`\ncandidates: ${counts.accept} accepted, ${counts.reject} rejected (${counts.byEvidence.metadata.total} with the defect in metadata, ${counts.byEvidence.pixels.total} visible only in the picture)`);
  if (!apiKey) {
    console.log("No API key — fixtures only, nothing judged.");
    console.log(`\nwrote ${outFile}`);
    return;
  }
  console.log(`\nflagged ${counts.flaggedReject}/${counts.reject} rejects, ${counts.flaggedAccept}/${counts.accept} accepted references`);
  console.log(`  metadata-visible defects caught: ${counts.byEvidence.metadata.flagged}/${counts.byEvidence.metadata.total}`);
  console.log(`  pixel-only defects caught:       ${counts.byEvidence.pixels.flagged}/${counts.byEvidence.pixels.total} (expected 0 — they are not in the metadata)`);
  console.log("\nper-candidate:");
  for (const entry of results.cases) {
    for (const judged of entry.judged.filter((candidate) => candidate.label === "reject" || candidate.flagged)) {
      console.log(
        `  ${judged.label.padEnd(6)} ${judged.flagged ? "FLAGGED" : "passed "} finish=${judged.finish?.toFixed(2) ?? "n/a"} variant=${judged.variant?.toFixed(2) ?? "n/a"}  ${judged.filename}${judged.reason ? ` — ${judged.reason}` : ""}`,
      );
    }
  }
  console.log(`\nusage: ${results.usage.requests} requests, ${results.usage.input_tokens} input tokens, ${results.usage.output_tokens} output tokens, ${results.usage.latencyMs} ms total`);
  console.log(`\nwrote ${outFile}`);
}

await main();
