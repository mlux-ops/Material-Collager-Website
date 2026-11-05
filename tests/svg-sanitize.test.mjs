import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeSvg, SvgSanitizeError, SVG_NAMESPACE } from "../app/lib/svg-sanitize.ts";

// ---------------------------------------------------------------------------
// A minimal XML DOM, standing in for DOMParser/XMLSerializer, which Node does
// not have (and the repo carries no DOM shim). It implements only what the
// sanitizer touches: elements with namespaces resolved from xmlns attributes,
// attributes, text/CDATA/comments, remove(), getAttribute/removeAttribute,
// textContent, and a <parsererror> document on malformed input -- which is
// how Firefox's and Chrome's DOMParser report an XML error.
// ---------------------------------------------------------------------------

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (entity in ENTITIES) return ENTITIES[entity];
    throw new Error(`undefined entity ${whole}`);
  });
}

const escapeText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value) => escapeText(value).replace(/"/g, "&quot;");

class MiniElement {
  constructor(name, parent) {
    this.name = name;
    this.parent = parent;
    this.attrs = [];
    this.nodes = [];
  }
  get localName() {
    const colon = this.name.indexOf(":");
    return colon === -1 ? this.name : this.name.slice(colon + 1);
  }
  lookupNamespace(prefix) {
    const key = prefix ? `xmlns:${prefix}` : "xmlns";
    const found = this.attrs.find((attr) => attr.name === key);
    if (found) return found.value || null;
    if (this.parent) return this.parent.lookupNamespace(prefix);
    return prefix === "xml" ? "http://www.w3.org/XML/1998/namespace" : null;
  }
  get namespaceURI() {
    const colon = this.name.indexOf(":");
    return this.lookupNamespace(colon === -1 ? "" : this.name.slice(0, colon));
  }
  get attributes() {
    return this.attrs.map((attr) => ({ ...attr }));
  }
  get children() {
    return this.nodes.filter((node) => node instanceof MiniElement);
  }
  get textContent() {
    return this.nodes.map((node) => (node instanceof MiniElement ? node.textContent : node.kind === "comment" ? "" : node.text)).join("");
  }
  getAttribute(name) {
    return this.attrs.find((attr) => attr.name === name)?.value ?? null;
  }
  removeAttribute(name) {
    this.attrs = this.attrs.filter((attr) => attr.name !== name);
  }
  remove() {
    if (this.parent) this.parent.nodes = this.parent.nodes.filter((node) => node !== this);
  }
  descendants() {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function parseXml(text) {
  let index = 0;
  const root = { nodes: [] };
  const stack = [];
  const current = () => stack[stack.length - 1];
  const append = (node) => (current() ? current().nodes.push(node) : root.nodes.push(node));
  const fail = (why) => { throw new Error(why); };
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index);
      if (end === -1) fail("unclosed comment");
      append({ kind: "comment", text: text.slice(index + 4, end) });
      index = end + 3;
    } else if (text.startsWith("<![CDATA[", index)) {
      const end = text.indexOf("]]>", index);
      if (end === -1) fail("unclosed CDATA");
      append({ kind: "text", text: text.slice(index + 9, end) });
      index = end + 3;
    } else if (text.startsWith("<?", index)) {
      const end = text.indexOf("?>", index);
      if (end === -1) fail("unclosed processing instruction");
      index = end + 2;
    } else if (text.startsWith("<!DOCTYPE", index)) {
      const end = text.indexOf(">", index);
      if (end === -1) fail("unclosed doctype");
      index = end + 1;
    } else if (text.startsWith("</", index)) {
      const end = text.indexOf(">", index);
      const name = text.slice(index + 2, end).trim();
      if (!current() || current().name !== name) fail(`mismatched </${name}>`);
      stack.pop();
      index = end + 1;
    } else if (text[index] === "<") {
      const tag = /^<([A-Za-z_][\w:.-]*)/.exec(text.slice(index));
      if (!tag) fail("bad tag");
      const element = new MiniElement(tag[1], current());
      index += tag[0].length;
      const attrPattern = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/;
      for (;;) {
        const rest = text.slice(index);
        const attr = attrPattern.exec(rest);
        if (attr) {
          if (element.attrs.some((existing) => existing.name === attr[1])) fail("duplicate attribute");
          element.attrs.push({ name: attr[1], value: decode(attr[3] ?? attr[4]) });
          index += attr[0].length;
          continue;
        }
        const close = /^\s*(\/?)>/.exec(rest);
        if (!close) fail("bad attribute");
        index += close[0].length;
        if (stack.length === 0 && root.nodes.some((node) => node instanceof MiniElement)) fail("two roots");
        append(element);
        if (!close[1]) stack.push(element);
        break;
      }
    } else {
      const end = text.indexOf("<", index);
      const chunk = text.slice(index, end === -1 ? text.length : end);
      if (!current() && chunk.trim()) fail("text outside the root");
      if (current()) append({ kind: "text", text: decode(chunk) });
      index = end === -1 ? text.length : end;
    }
  }
  if (stack.length) fail("unclosed element");
  const documentElement = root.nodes.find((node) => node instanceof MiniElement);
  if (!documentElement) fail("no root element");
  return documentElement;
}

function serialize(element) {
  const attrs = element.attrs.map((attr) => ` ${attr.name}="${escapeAttr(attr.value)}"`).join("");
  if (!element.nodes.length) return `<${element.name}${attrs}/>`;
  const inner = element.nodes.map((node) => {
    if (node instanceof MiniElement) return serialize(node);
    if (node.kind === "comment") return `<!--${node.text}-->`;
    return escapeText(node.text);
  }).join("");
  return `<${element.name}${attrs}>${inner}</${element.name}>`;
}

const environment = {
  parse(text) {
    let documentElement;
    try {
      documentElement = parseXml(text);
    } catch (error) {
      documentElement = new MiniElement("parsererror", null);
      documentElement.nodes.push({ kind: "text", text: String(error.message) });
    }
    return {
      documentElement,
      getElementsByTagName: (name) => [documentElement, ...documentElement.descendants()].filter((element) => element.localName === name),
    };
  },
  serialize,
};

const clean = (svg) => sanitizeSvg(svg, environment);
const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';

// ---------------------------------------------------------------------------

test("script, foreignObject, iframe, embed, object, audio and video are removed with their content", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}"><script>alert(1)</script><rect width="4" height="4"/>`
    + `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><script>alert(2)</script></div></foreignObject>`
    + `<iframe src="https://evil.test"/><embed src="x"/><object data="x"/><audio src="a"/><video src="v"/></svg>`);
  assert.doesNotMatch(out, /script|alert|foreignObject|iframe|embed|object|audio|video/i);
  assert.match(out, /<rect width="4" height="4"\/>/);
});

test("every on* handler attribute is dropped, on the root and on descendants", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}" onload="alert(1)"><g onclick="alert(2)" ONMOUSEOVER="x"><circle r="2" onfocus="x"/></g></svg>`);
  assert.doesNotMatch(out, /on(load|click|mouseover|focus)/i);
  assert.match(out, /<circle r="2"\/>/);
});

test("javascript: and external hrefs are dropped; #fragment and inline raster data survive", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}" ${XLINK}>`
    + `<a href="javascript:alert(1)"><text>a</text></a>`
    + `<a xlink:href="  JaVa&#x0A;Script:alert(1)"><text>b</text></a>`
    + `<image xlink:href="https://evil.test/track.png" width="1" height="1"/>`
    + `<use xlink:href="https://evil.test/sprite.svg#icon"/>`
    + `<use href="#shape"/>`
    + `<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>`
    + `<image href="data:text/html;base64,PHNjcmlwdD4=" width="1" height="1"/>`
    + `</svg>`);
  assert.doesNotMatch(out, /javascript|evil\.test|data:text/i);
  assert.match(out, /<use href="#shape"\/>/);
  assert.match(out, /href="data:image\/png;base64,iVBORw0KGgo="/);
});

test("style elements with @import or external url() are removed; style attributes with them are dropped", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}">`
    + `<style>@import url("https://evil.test/x.css");</style>`
    + `<style>rect { fill: url(https://evil.test/p.svg#g); }</style>`
    + `<style>rect { background: u\\72l(https://evil.test); }</style>`
    + `<style>.keep { fill: url(#grad); }</style>`
    + `<rect style="fill: url('https://evil.test/a')" fill="url(https://evil.test/b)" width="1" height="1"/>`
    + `<rect style="fill:red" fill="url(#grad)" width="2" height="2"/>`
    + `</svg>`);
  assert.doesNotMatch(out, /@import|evil\.test|\\72/);
  assert.match(out, /<style>\.keep \{ fill: url\(#grad\); \}<\/style>/);
  assert.match(out, /<rect width="1" height="1"\/>/);
  assert.match(out, /<rect style="fill:red" fill="url\(#grad\)" width="2" height="2"\/>/);
});

test("animations that retarget href or a handler are removed; ordinary animations stay", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}"><a href="#x">`
    + `<set attributeName="href" to="javascript:alert(1)"/>`
    + `<animate attributeName="xlink:href" values="javascript:alert(1)"/>`
    + `<set attributeName="onclick" to="alert(1)"/>`
    + `<animate attributeName="opacity" from="0" to="1" dur="1s"/>`
    + `</a></svg>`);
  assert.doesNotMatch(out, /javascript|onclick|<set/);
  assert.match(out, /<animate attributeName="opacity" from="0" to="1" dur="1s"\/>/);
});

test("non-SVG-namespace elements and elements outside the allowlist are removed", () => {
  const out = clean(`<svg xmlns="${SVG_NAMESPACE}"><html:div xmlns:html="http://www.w3.org/1999/xhtml">x</html:div><unknownThing/><path d="M0 0L1 1"/></svg>`);
  assert.doesNotMatch(out, /div|unknownThing/);
  assert.match(out, /<path d="M0 0L1 1"\/>/);
});

test("a benign SVG with paths, gradients, a pattern, text and a #fragment <use> comes through unchanged", () => {
  const benign = `<svg xmlns="${SVG_NAMESPACE}" ${XLINK} viewBox="0 0 64 64" width="64" height="64">`
    + `<title>Swatch</title>`
    + `<defs><linearGradient id="grad" x1="0" x2="1"><stop offset="0" stop-color="#c8b8a0"/><stop offset="1" stop-color="#5a4a3a"/></linearGradient>`
    + `<radialGradient id="glow"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
    + `<pattern id="weave" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0H4V2H0Z" fill="#000" fill-opacity="0.1"/></pattern>`
    + `<symbol id="tile"><rect width="16" height="16" rx="2"/></symbol>`
    + `<clipPath id="clip"><circle cx="32" cy="32" r="30"/></clipPath>`
    + `<filter id="soft"><feGaussianBlur stdDeviation="1"/></filter></defs>`
    + `<g clip-path="url(#clip)" filter="url(#soft)"><rect width="64" height="64" fill="url(#grad)"/>`
    + `<rect width="64" height="64" fill="url(#weave)"/><circle cx="20" cy="20" r="12" fill="url(#glow)"/></g>`
    + `<use href="#tile" x="4" y="4" fill="#657069"/><use xlink:href="#tile" x="44" y="44"/>`
    + `<text x="32" y="60" font-size="6" text-anchor="middle">Walnut &amp; brass</text>`
    + `<style>.a { fill: url(#grad); stroke: #000; }</style>`
    + `</svg>`;
  assert.equal(clean(benign), benign);
});

test("malformed XML, a non-SVG root, or an SVG outside the SVG namespace is refused", () => {
  for (const input of [
    "",
    "not xml at all",
    `<svg xmlns="${SVG_NAMESPACE}"><g></svg>`,
    `<svg xmlns="${SVG_NAMESPACE}"><rect/></svg><svg/>`,
    `<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>`,
    `<svg><rect width="1" height="1"/></svg>`,
    `<svg xmlns="${SVG_NAMESPACE}">&bogus;</svg>`,
  ]) {
    assert.throws(() => clean(input), SvgSanitizeError, JSON.stringify(input));
  }
});

test("a DOCTYPE and processing instructions outside the root never reach the output", () => {
  const out = clean(`<?xml version="1.0"?><?xml-stylesheet href="https://evil.test/x.css"?><!DOCTYPE svg><svg xmlns="${SVG_NAMESPACE}"><rect width="1" height="1"/></svg>`);
  assert.equal(out, `<svg xmlns="${SVG_NAMESPACE}"><rect width="1" height="1"/></svg>`);
});

test("with no injected parser and no platform DOMParser, sanitizing refuses rather than passing bytes through", () => {
  assert.throws(() => sanitizeSvg(`<svg xmlns="${SVG_NAMESPACE}"/>`), SvgSanitizeError);
});

test("a sanitized SVG is cached under an opaque-origin data: URL, and a raw SVG cannot get a blob: URL", async () => {
  const { getBlob, getBlobUrl, putBlob, putSvgBlob, releaseBlob } = await import("../app/components/workbench/blob-cache.ts");
  const svg = `<svg xmlns="${SVG_NAMESPACE}"><text>Ø walnut</text></svg>`;
  const url = putSvgBlob("svg-test:0", svg);
  assert.match(url, /^data:image\/svg\+xml;base64,/);
  assert.equal(getBlobUrl("svg-test:0"), url);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0))), svg);
  assert.equal(getBlob("svg-test:0").type, "image/svg+xml");
  assert.equal(await getBlob("svg-test:0").text(), svg);
  releaseBlob("svg-test:0");
  assert.throws(() => putBlob("svg-test:1", new Blob([svg], { type: "image/svg+xml" })), /putSvgBlob/);
});
