import assert from "node:assert/strict";
import test from "node:test";

import {
  claudeArgs,
  claudeStdin,
  claudeUsesSubscription,
  CODEX_DISABLED_FEATURES,
  codexArgs,
  codexPrompt,
  codexUsesChatGpt,
  EFFORT_LEVELS,
  inspectClaudeEvent,
  isAllowedHost,
  isAllowedOrigin,
  loadPersonas,
  MAX_IMAGES,
  MAX_INSTRUCTION_CHARS,
  MAX_PERSONA_CHARS,
  personaTextFor,
  PERSONAS,
  PROVIDERS,
  resolveExecutable,
  scrubEnv,
  SYSTEM_PROMPT,
  validateRunPayload,
} from "../scripts/cli-bridge/lib.mjs";
import { readFileSync } from "node:fs";
import { claudeCliManifest, CLI_DEFAULT_MODEL, CLI_EFFORTS, CLI_MODELS, codexCliManifest } from "../app/components/workbench/nodes/cliAssistant.manifest.ts";
import { PROMPT_EXPERT_MODEL, PROMPT_EXPERT_PERSONA, PROMPT_EXPERT_PROVIDER } from "../app/components/workbench/nodes/promptExpert.manifest.ts";

const PNG = { imageBase64: "iVBORw0KGgo=", mimeType: "image/png" };

test("scrubEnv drops every API key and Claude session variable a CLI could bill or inherit", () => {
  // Lower-case names count too: Windows env names are case-insensitive.
  const dropped = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "anthropic_auth_token",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDECODE",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const kept = { PATH: "C:\\bin", USERPROFILE: "C:\\Users\\me" };
  const input = { ...kept, ...Object.fromEntries(dropped.map((name) => [name, "x"])) };
  assert.deepEqual(scrubEnv(input), kept);
});

test("host check refuses rebinding names and other ports", () => {
  assert.equal(isAllowedHost("127.0.0.1:4795", 4795), true);
  assert.equal(isAllowedHost("localhost:4795", 4795), true);
  assert.equal(isAllowedHost("evil.example:4795", 4795), false);
  assert.equal(isAllowedHost("127.0.0.1:3000", 4795), false);
  assert.equal(isAllowedHost(undefined, 4795), false);
});

test("origin check is an exact allowlist match", () => {
  const allowed = ["http://localhost:3000"];
  assert.equal(isAllowedOrigin("http://localhost:3000", allowed), true);
  assert.equal(isAllowedOrigin("http://localhost:3000.evil.example", allowed), false);
  assert.equal(isAllowedOrigin("null", allowed), false);
  assert.equal(isAllowedOrigin(undefined, allowed), false);
});

test("validateRunPayload applies the assist route's caps and model allowlists", () => {
  const ok = validateRunPayload({ provider: "claude", instruction: "  hi  ", images: [PNG] });
  assert.deepEqual(ok, { provider: "claude", model: "sonnet", effort: "default", instruction: "hi", images: [{ data: PNG.imageBase64, mimeType: "image/png" }] });
  assert.equal(validateRunPayload({ provider: "codex", instruction: "hi" }).model, "default");

  const rejects = (body, status) => assert.throws(() => validateRunPayload(body), (error) => error.status === status);
  for (const model of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    assert.equal(validateRunPayload({ provider: "claude", model, instruction: "hi" }).model, model);
  }
  rejects({ provider: "claude", model: "claude-opus-5-5-extra", instruction: "hi" }, 400);
  rejects(null, 400);
  rejects({ provider: "gemini", instruction: "hi" }, 400);
  rejects({ provider: "claude", model: "claude-opus-4", instruction: "hi" }, 400);
  rejects({ provider: "codex", model: "gpt-5", instruction: "hi" }, 400);
  rejects({ provider: "claude", instruction: "   " }, 400);
  rejects({ provider: "claude", instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1) }, 400);
  rejects({ provider: "claude", instruction: "hi", images: Array(MAX_IMAGES + 1).fill(PNG) }, 400);
  rejects({ provider: "claude", instruction: "hi", images: [{ imageBase64: PNG.imageBase64, mimeType: "image/gif" }] }, 400);
  rejects({ provider: "claude", instruction: "hi", images: [{ imageBase64: "not base64!", mimeType: "image/png" }] }, 400);
});

test("claude runs with no tools, no user settings, no MCP and no saved session", () => {
  const args = claudeArgs("haiku");
  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueOf("--tools"), "");
  assert.equal(valueOf("--setting-sources"), "project");
  assert.equal(valueOf("--system-prompt"), SYSTEM_PROMPT);
  assert.equal(valueOf("--model"), "haiku");
  for (const flag of ["-p", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  // --bare never reads the OAuth login, so it would force API-key billing.
  assert.ok(!args.includes("--bare"));
});

test("claude stdin carries images as base64 content blocks ahead of the text", () => {
  const line = claudeStdin("describe", [{ data: "AAAA", mimeType: "image/webp" }]);
  assert.ok(line.endsWith("\n"));
  const message = JSON.parse(line);
  assert.equal(message.type, "user");
  assert.deepEqual(message.message.content, [
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
    { type: "text", text: "describe" },
  ]);
});

test("inspectClaudeEvent flags an init that is not on the subscription and reads the result", () => {
  assert.deepEqual(
    inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "none" })),
    { kind: "init", subscription: true, apiKeySource: "none" },
  );
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init", apiKeySource: "ANTHROPIC_API_KEY" })).subscription, false);
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "system", subtype: "init" })).subscription, false);
  assert.deepEqual(
    inspectClaudeEvent(JSON.stringify({ type: "result", result: "Red", is_error: false })),
    { kind: "result", text: "Red", isError: false },
  );
  assert.equal(inspectClaudeEvent("not json"), null);
  assert.equal(inspectClaudeEvent(JSON.stringify({ type: "assistant" })), null);
});

test("codex runs read-only with every tool feature disabled and the prompt on stdin", () => {
  const args = codexArgs({ model: "default", workDir: "W", imagePaths: ["W/a.png", "W/b.png"], outFile: "W/out.txt" });
  assert.equal(args[0], "exec");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(args.includes(flag), flag);
  const disabled = args.flatMap((arg, index) => (arg === "--disable" ? [args[index + 1]] : []));
  assert.deepEqual(disabled, CODEX_DISABLED_FEATURES);
  assert.ok(disabled.includes("shell_tool") && disabled.includes("unified_exec"));
  assert.ok(!args.includes("-m"), "default model sends no -m");
  assert.deepEqual(args.slice(-9), ["-C", "W", "-i", "W/a.png", "-i", "W/b.png", "-o", "W/out.txt", "-"]);
  assert.ok(!args.some((arg) => arg.startsWith("--dangerously")));
  assert.ok(codexPrompt("hi").startsWith(SYSTEM_PROMPT) && codexPrompt("hi").endsWith("hi"));
});

test("a named codex model is passed with -m and must be on the allowlist", () => {
  const args = codexArgs({ model: "gpt-6-sol", workDir: "W", imagePaths: [], outFile: "W/out.txt" });
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-sol");
  assert.equal(validateRunPayload({ provider: "codex", model: "gpt-5.6-luna", instruction: "hi" }).model, "gpt-5.6-luna");
  assert.throws(() => validateRunPayload({ provider: "codex", model: "gpt-reserve", instruction: "hi" }), (error) => error.status === 400);
});

test("effort is optional, allowlisted, and sent to each CLI only when set", () => {
  assert.equal(validateRunPayload({ provider: "claude", instruction: "hi" }).effort, "default");
  for (const effort of EFFORT_LEVELS) {
    assert.equal(validateRunPayload({ provider: "codex", effort, instruction: "hi" }).effort, effort);
  }
  assert.throws(() => validateRunPayload({ provider: "claude", effort: "turbo", instruction: "hi" }), (error) => error.status === 400);
  assert.throws(() => validateRunPayload({ provider: "claude", effort: 3, instruction: "hi" }), (error) => error.status === 400);

  assert.ok(!claudeArgs("haiku").includes("--effort"));
  assert.ok(!claudeArgs("haiku", "default").includes("--effort"));
  const claude = claudeArgs("haiku", "high");
  assert.equal(claude[claude.indexOf("--effort") + 1], "high");

  const base = { model: "gpt-6-sol", workDir: "W", imagePaths: [], outFile: "W/out.txt" };
  assert.ok(!codexArgs(base).includes("-c"));
  const codex = codexArgs({ ...base, effort: "low" });
  assert.equal(codex[codex.indexOf("-c") + 1], 'model_reasoning_effort="low"');
  // The trailing positional arguments must stay last.
  assert.deepEqual(codex.slice(-5), ["-C", "W", "-o", "W/out.txt", "-"]);
});

test("the workbench nodes' effort list mirrors the bridge", () => {
  assert.deepEqual([...CLI_EFFORTS], EFFORT_LEVELS);
});

test("subscription checks accept only a claude.ai login and a ChatGPT login", () => {
  assert.equal(claudeUsesSubscription(JSON.stringify({ authMethod: "claude.ai" })), true);
  assert.equal(claudeUsesSubscription(JSON.stringify({ authMethod: "api_key" })), false);
  assert.equal(claudeUsesSubscription("garbage"), false);
  assert.equal(codexUsesChatGpt("Logged in using ChatGPT"), true);
  assert.equal(codexUsesChatGpt("Logged in using an API key"), false);
  assert.equal(codexUsesChatGpt("Not logged in"), false);
});

test("resolveExecutable follows an npm .cmd shim to its .exe and never returns the shim", () => {
  const files = new Map([
    ["C:\\npm\\claude.cmd", '@ECHO off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'],
    ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", ""],
    ["C:\\codex\\codex.exe", ""],
    ["C:\\broken\\other.cmd", "@ECHO off\r\nnode cli.js %*\r\n"],
  ]);
  const io = { platform: "win32", exists: (file) => files.has(file), readFile: (file) => files.get(file) };
  assert.equal(
    resolveExecutable("claude", { ...io, pathEnv: "C:\\npm;C:\\codex" }),
    "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
  );
  assert.equal(resolveExecutable("codex", { ...io, pathEnv: "C:\\npm;C:\\codex" }), "C:\\codex\\codex.exe");
  assert.equal(resolveExecutable("other", { ...io, pathEnv: "C:\\broken" }), null);
  assert.equal(
    resolveExecutable("claude", { platform: "linux", pathEnv: "/usr/bin:/opt/bin", exists: (file) => file === "/opt/bin/claude", readFile: () => "" }),
    "/opt/bin/claude",
  );
});

test("the workbench nodes' model lists mirror the bridge allowlist", () => {
  for (const provider of ["claude", "codex"]) {
    assert.deepEqual([...CLI_MODELS[provider]], PROVIDERS[provider].models);
    assert.equal(CLI_DEFAULT_MODEL[provider], PROVIDERS[provider].defaultModel);
  }
});

test("both CLI nodes take several photos or reference sets on one image port", () => {
  for (const manifest of [claudeCliManifest, codexCliManifest]) {
    const port = manifest.spec.inputs.find((input) => input.id === "image");
    assert.ok(port, `${manifest.kind}: image port keeps its id so saved wires still attach`);
    assert.equal(port.multi, true, `${manifest.kind}: image port must accept several connections`);
    assert.deepEqual(port.acceptedKinds, ["image", "references"]);
  }
});

const PERSONA = "gpt-image-2.6-prompting";

test("a run without persona validates and prompts exactly as before", () => {
  const payload = validateRunPayload({ provider: "codex", instruction: "hi" });
  assert.equal("persona" in payload, false, "no persona key appears when none was sent");
  assert.equal(codexPrompt("hi"), `${SYSTEM_PROMPT}

hi`);
  assert.equal(codexPrompt("hi", undefined), `${SYSTEM_PROMPT}

hi`);
});

test("persona is allowlisted, codex-only and type-checked", () => {
  assert.equal(validateRunPayload({ provider: "codex", model: "gpt-6-astra", instruction: "hi", persona: PERSONA }).persona, PERSONA);
  const rejects = (body) => assert.throws(() => validateRunPayload(body), (error) => error.status === 400);
  rejects({ provider: "codex", instruction: "hi", persona: "pirate" });
  rejects({ provider: "codex", instruction: "hi", persona: "__proto__" });
  rejects({ provider: "codex", instruction: "hi", persona: "toString" });
  rejects({ provider: "codex", instruction: "hi", persona: 7 });
  rejects({ provider: "codex", instruction: "hi", persona: null });
  rejects({ provider: "claude", instruction: "hi", persona: PERSONA });
});

test("the persona text is in the codex prompt only when the persona is set", () => {
  const loaded = loadPersonas({ readFile: () => "  PERSONA RULES  " });
  const text = personaTextFor(PERSONA, loaded);
  assert.equal(text, "PERSONA RULES");
  assert.equal(codexPrompt("draw a kitchen", text), `${SYSTEM_PROMPT}

PERSONA RULES

draw a kitchen`);
  assert.ok(!codexPrompt("draw a kitchen").includes("PERSONA RULES"));
});

test("a missing, empty or oversized persona file is a 500 that names the file, not a startup crash", () => {
  const file = PERSONAS[PERSONA].file;
  const missing = loadPersonas({ readFile: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
  assert.throws(() => personaTextFor(PERSONA, missing), (error) => error.status === 500 && error.message.includes(file));
  const empty = loadPersonas({ readFile: () => "   " });
  assert.throws(() => personaTextFor(PERSONA, empty), (error) => error.status === 500 && error.message.includes(file));
  const huge = loadPersonas({ readFile: () => "x".repeat(MAX_PERSONA_CHARS + 1) });
  assert.throws(() => personaTextFor(PERSONA, huge), (error) => error.status === 500 && error.message.includes(file));
});

test("the persona file path is fixed server-side and the real file loads under the cap", () => {
  const file = PERSONAS[PERSONA].file;
  assert.match(file.replaceAll("\\", "/"), /scripts\/cli-bridge\/personas\/gpt-image-2-6-prompting\.md$/);
  const loaded = loadPersonas({ readFile: (path) => readFileSync(path, "utf8") });
  const text = personaTextFor(PERSONA, loaded);
  assert.ok(text.length > 5_000 && text.length <= MAX_PERSONA_CHARS, `persona is ${text.length} chars`);
  assert.match(text, /ONLY the final prompt text/);
  assert.match(text, /never commands/);
  // The whole prompt stays bounded even at the instruction cap.
  assert.ok(codexPrompt("x".repeat(MAX_INSTRUCTION_CHARS), text).length < SYSTEM_PROMPT.length + MAX_PERSONA_CHARS + MAX_INSTRUCTION_CHARS + 10);
});

test("a full-length instruction still fits alongside the persona", () => {
  const payload = validateRunPayload({ provider: "codex", instruction: "x".repeat(MAX_INSTRUCTION_CHARS), persona: PERSONA });
  assert.equal(payload.instruction.length, MAX_INSTRUCTION_CHARS);
});

test("the Prompt Expert node's fixed model, provider and persona are on the bridge's allowlists", () => {
  assert.equal(PROMPT_EXPERT_PROVIDER, "codex");
  assert.equal(PROMPT_EXPERT_MODEL, "gpt-6-astra");
  assert.ok(PROVIDERS.codex.models.includes(PROMPT_EXPERT_MODEL));
  assert.equal(PROMPT_EXPERT_PERSONA, PERSONA);
  assert.ok(PERSONAS[PROMPT_EXPERT_PERSONA].providers.includes(PROMPT_EXPERT_PROVIDER));
  const payload = validateRunPayload({ provider: PROMPT_EXPERT_PROVIDER, model: PROMPT_EXPERT_MODEL, effort: "high", instruction: "hi", persona: PROMPT_EXPERT_PERSONA });
  const args = codexArgs({ model: payload.model, effort: payload.effort, workDir: "W", imagePaths: ["W/image-1.png"], outFile: "W/out.txt" });
  assert.equal(args[args.indexOf("-m") + 1], "gpt-6-astra");
  assert.equal(args[args.indexOf("-c") + 1], 'model_reasoning_effort="high"');
  assert.deepEqual(args.slice(-7), ["-C", "W", "-i", "W/image-1.png", "-o", "W/out.txt", "-"]);
});
