/**
 * Sanitizer for model-returned SVG (Image Generation's SVG output).
 *
 * The bytes come back from the model, and the prompt that shaped them can
 * come from upstream text or web-sourced nodes. A cached SVG with script in
 * it would run in the app's origin if its blob: URL were ever opened as a
 * document. So every SVG is parsed, reduced to an allowlist of SVG elements,
 * stripped of anything that can run script or fetch a resource, and
 * re-serialized before it is cached, displayed or downloaded.
 *
 * Framework-free: it uses the platform DOMParser/XMLSerializer by default,
 * and tests inject their own (Node has neither).
 */

export const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

// Elements kept (compared lower-cased; SVG names are camelCase). Anything
// else, and anything outside the SVG namespace, is removed with its subtree.
const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "switch", "view", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath",
  "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker",
  "image", "a", "style",
  "animate", "animatetransform", "animatemotion", "set", "mpath",
  "filter", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix",
  "fediffuselighting", "fedisplacementmap", "fedistantlight", "fedropshadow", "feflood",
  "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge",
  "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting",
  "fespotlight", "fetile", "feturbulence",
]);

const ANIMATION_ELEMENTS = new Set(["animate", "animatetransform", "animatemotion", "set"]);

// Same-document fragment, or an inline raster image.
const SAFE_HREF = /^(#[^\s]*|data:image\/(png|jpeg|webp|gif)[;,])/i;

export class SvgSanitizeError extends Error {}

// The DOM surface this module touches; the platform DOM satisfies it.
export type SanitizerAttr = { name: string; value: string };
export type SanitizerElement = {
  localName: string;
  namespaceURI: string | null;
  attributes: ArrayLike<SanitizerAttr>;
  children: ArrayLike<SanitizerElement>;
  textContent: string | null;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  remove(): void;
};
export type SanitizerDocument = {
  documentElement: SanitizerElement | null;
  getElementsByTagName(name: string): ArrayLike<unknown>;
};
export type SanitizerEnvironment = {
  parse: (text: string) => SanitizerDocument;
  serialize: (element: SanitizerElement) => string;
};

function platformEnvironment(): SanitizerEnvironment {
  const Parser = (globalThis as { DOMParser?: new () => { parseFromString(text: string, type: string): unknown } }).DOMParser;
  const Serializer = (globalThis as { XMLSerializer?: new () => { serializeToString(node: unknown): string } }).XMLSerializer;
  if (!Parser || !Serializer) throw new SvgSanitizeError("SVG cannot be checked in this environment.");
  return {
    parse: (text) => new Parser().parseFromString(text, "image/svg+xml") as SanitizerDocument,
    serialize: (element) => new Serializer().serializeToString(element),
  };
}

// Lower-cased with whitespace and control characters removed, so
// "java\nscript:" or "JaVaScRiPt :" cannot slip past a substring check.
function squashed(value: string): string {
  return value.replace(/[\s\u0000-\u001f]+/g, "").toLowerCase();
}

// True when every url(...) in the value points at a same-document fragment.
function urlsAreFragments(value: string): boolean {
  const pattern = /url\s*\(\s*(['"]?)([^'")]*)\1?\s*\)?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (!match[2].trim().startsWith("#")) return false;
  }
  return true;
}

// A value that could run script or load something outside the document.
function unsafeValue(value: string): boolean {
  const flat = squashed(value);
  if (flat.includes("javascript:") || flat.includes("vbscript:") || flat.includes("data:text")) return true;
  if (flat.includes("url(") && !urlsAreFragments(value)) return true;
  return false;
}

// CSS (a <style> element or a style attribute): also refuse @import,
// expression() and any backslash, since CSS escapes can spell url( or
// javascript: past the checks above.
function unsafeCss(css: string): boolean {
  const flat = squashed(css);
  return flat.includes("@import") || flat.includes("expression(") || css.includes("\\") || unsafeValue(css);
}

function localPart(name: string): string {
  const colon = name.indexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

function cleanAttributes(element: SanitizerElement) {
  const names = Array.from(element.attributes, (attribute) => attribute.name);
  for (const name of names) {
    const value = element.getAttribute(name) ?? "";
    const lower = name.toLowerCase();
    const local = localPart(name);
    let drop = false;
    if (lower.startsWith("on") || local.startsWith("on")) drop = true;
    else if (local === "href") drop = !SAFE_HREF.test(value.trim());
    else if (lower === "style") drop = unsafeCss(value);
    else drop = unsafeValue(value);
    if (drop) element.removeAttribute(name);
  }
}

function elementAllowed(element: SanitizerElement): boolean {
  if (element.namespaceURI !== SVG_NAMESPACE) return false;
  const name = element.localName.toLowerCase();
  if (!ALLOWED_ELEMENTS.has(name)) return false;
  if (ANIMATION_ELEMENTS.has(name)) {
    // An animation that rewrites a link or a handler can smuggle script in
    // after sanitizing.
    const target = squashed(element.getAttribute("attributeName") ?? "");
    if (localPart(target) === "href" || localPart(target).startsWith("on")) return false;
  }
  if (name === "style" && unsafeCss(element.textContent ?? "")) return false;
  return true;
}

function cleanTree(element: SanitizerElement) {
  for (const child of Array.from(element.children)) {
    if (!elementAllowed(child)) {
      child.remove();
      continue;
    }
    cleanAttributes(child);
    cleanTree(child);
  }
}

/**
 * Returns a sanitized serialization of `text`, or throws SvgSanitizeError
 * when it does not parse as XML or its root is not an SVG-namespace <svg>.
 */
export function sanitizeSvg(text: string, environment: SanitizerEnvironment = platformEnvironment()): string {
  let document: SanitizerDocument;
  try {
    document = environment.parse(text);
  } catch {
    throw new SvgSanitizeError("The SVG could not be parsed.");
  }
  const root = document.documentElement;
  if (!root || document.getElementsByTagName("parsererror").length > 0) {
    throw new SvgSanitizeError("The SVG could not be parsed.");
  }
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NAMESPACE) {
    throw new SvgSanitizeError("The file is not an SVG image.");
  }
  cleanAttributes(root);
  cleanTree(root);
  // Only the root element is serialized: a DOCTYPE, its entity
  // declarations and any processing instruction outside it are dropped.
  return environment.serialize(root);
}
