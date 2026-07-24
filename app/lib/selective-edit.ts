// Shared client-side selective (masked) QA edit helpers: building the
// compressed base image + PNG mask for a masked repair request, and
// compositing the edited result back over the original with feathered blending
// so unselected pixels are restored exactly. Extracted verbatim from the
// generator page; runs in the browser (canvas, Image, document).
import { type QaSelectionInput } from "@/app/lib/collage";

export type NormalizedBox = [number, number, number, number];

export type QaItemResult = {
  id: string;
  passed: boolean;
  finding: string;
  box?: NormalizedBox;
};

export type QaResult = {
  passed: boolean;
  score: number;
  findings: string[];
  recommendation: string;
  items: QaItemResult[];
  reviewFailed?: boolean;
};

export type QaRedoRequest = {
  feedback: QaResult;
  itemIds: string[];
  sourceDataUrl: string;
};

export type SelectiveEditAssets = {
  baseFile: File;
  maskFile: File;
  boxes: NormalizedBox[];
  protectedBoxes: NormalizedBox[];
  selection: QaSelectionInput;
};

const SELECTIVE_EDIT_BASE_BUDGET = 420 * 1024;

function expandedBox(box: NormalizedBox, padding = 24): NormalizedBox {
  const [x, y, width, height] = box;
  const left = Math.max(0, x - padding);
  const top = Math.max(0, y - padding);
  const right = Math.min(1000, x + width + padding);
  const bottom = Math.min(1000, y + height + padding);
  return [left, top, right - left, bottom - top];
}

async function loadCanvasImage(source: string) {
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The collage image could not be prepared for selective editing."));
    image.src = source;
  });
  return image;
}

function canvasBlob(canvas: HTMLCanvasElement, type = "image/png", quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The selective edit image could not be created.")), type, quality);
  });
}

async function compressedEditBase(image: HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare the current collage for editing.");
  context.drawImage(image, 0, 0);
  let blob = await canvasBlob(canvas, "image/jpeg", 0.86);
  for (const quality of [0.76, 0.66, 0.56, 0.48, 0.4, 0.34]) {
    if (blob.size <= SELECTIVE_EDIT_BASE_BUDGET) break;
    blob = await canvasBlob(canvas, "image/jpeg", quality);
  }
  return blob;
}

export async function createSelectiveEditAssets(request: QaRedoRequest): Promise<SelectiveEditAssets> {
  const selected = new Set(request.itemIds);
  const boxes = request.feedback.items
    .filter((item) => selected.has(item.id))
    .map((item) => item.box ? expandedBox(item.box) : undefined);
  if (boxes.some((box) => !box) || boxes.length !== selected.size) {
    throw new Error("QA could not locate every selected item. Generate once more to refresh the item map.");
  }

  const normalizedBoxes = boxes as NormalizedBox[];
  const protectedBoxes = request.feedback.items
    .filter((item) => !selected.has(item.id) && item.box)
    .map((item) => expandedBox(item.box as NormalizedBox, 12));
  const sourceImage = await loadCanvasImage(request.sourceDataUrl);
  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  if (!width || !height || width % 16 !== 0 || height % 16 !== 0) {
    throw new Error("The current collage dimensions cannot be used for a masked correction.");
  }

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) throw new Error("This browser cannot create a selective edit mask.");
  maskContext.fillStyle = "#000";
  maskContext.fillRect(0, 0, width, height);
  for (const [x, y, boxWidth, boxHeight] of normalizedBoxes) {
    maskContext.clearRect(
      Math.floor(x / 1000 * width),
      Math.floor(y / 1000 * height),
      Math.ceil(boxWidth / 1000 * width),
      Math.ceil(boxHeight / 1000 * height),
    );
  }
  maskContext.fillStyle = "#000";
  for (const [x, y, boxWidth, boxHeight] of protectedBoxes) {
    maskContext.fillRect(
      Math.floor(x / 1000 * width),
      Math.floor(y / 1000 * height),
      Math.ceil(boxWidth / 1000 * width),
      Math.ceil(boxHeight / 1000 * height),
    );
  }

  const [baseBlob, maskBlob] = await Promise.all([compressedEditBase(sourceImage), canvasBlob(maskCanvas)]);
  return {
    baseFile: new File([baseBlob], "current-collage.jpg", { type: "image/jpeg", lastModified: Date.now() }),
    maskFile: new File([maskBlob], "qa-edit-mask.png", { type: "image/png", lastModified: Date.now() }),
    boxes: normalizedBoxes,
    protectedBoxes,
    selection: { itemIds: request.itemIds, baseWidth: width, baseHeight: height },
  };
}

export async function compositeSelectiveEdit(
  originalSource: string,
  editedSource: string,
  boxes: NormalizedBox[],
  protectedBoxes: NormalizedBox[],
) {
  const [original, edited] = await Promise.all([loadCanvasImage(originalSource), loadCanvasImage(editedSource)]);
  const width = original.naturalWidth;
  const height = original.naturalHeight;
  const canvas = document.createElement("canvas");
  const editedLayer = document.createElement("canvas");
  const hardMask = document.createElement("canvas");
  const coreMask = document.createElement("canvas");
  const blendMask = document.createElement("canvas");
  for (const target of [canvas, editedLayer, hardMask, coreMask, blendMask]) {
    target.width = width;
    target.height = height;
  }
  const context = canvas.getContext("2d");
  const editedContext = editedLayer.getContext("2d");
  const hardContext = hardMask.getContext("2d");
  const coreContext = coreMask.getContext("2d");
  const blendContext = blendMask.getContext("2d");
  if (!context || !editedContext || !hardContext || !coreContext || !blendContext) {
    throw new Error("This browser cannot merge the selective QA correction.");
  }

  const feather = Math.max(8, Math.min(28, Math.round(Math.min(width, height) * 0.009)));
  hardContext.fillStyle = "#fff";
  coreContext.fillStyle = "#fff";
  for (const [x, y, boxWidth, boxHeight] of boxes) {
    const left = Math.floor(x / 1000 * width);
    const top = Math.floor(y / 1000 * height);
    const pixelWidth = Math.ceil(boxWidth / 1000 * width);
    const pixelHeight = Math.ceil(boxHeight / 1000 * height);
    hardContext.fillRect(left, top, pixelWidth, pixelHeight);
    const inset = Math.min(feather, Math.floor(pixelWidth / 4), Math.floor(pixelHeight / 4));
    coreContext.fillRect(left + inset, top + inset, Math.max(1, pixelWidth - inset * 2), Math.max(1, pixelHeight - inset * 2));
  }
  for (const maskContext of [hardContext, coreContext]) {
    maskContext.globalCompositeOperation = "destination-out";
    for (const [x, y, boxWidth, boxHeight] of protectedBoxes) {
      maskContext.fillRect(
        Math.floor(x / 1000 * width),
        Math.floor(y / 1000 * height),
        Math.ceil(boxWidth / 1000 * width),
        Math.ceil(boxHeight / 1000 * height),
      );
    }
    maskContext.globalCompositeOperation = "source-over";
  }

  blendContext.filter = `blur(${feather}px)`;
  blendContext.drawImage(coreMask, 0, 0);
  blendContext.filter = "none";
  blendContext.globalCompositeOperation = "destination-in";
  blendContext.drawImage(hardMask, 0, 0);

  editedContext.drawImage(edited, 0, 0, width, height);
  editedContext.globalCompositeOperation = "destination-in";
  editedContext.drawImage(blendMask, 0, 0);

  context.drawImage(original, 0, 0, width, height);
  context.drawImage(editedLayer, 0, 0);
  return URL.createObjectURL(await canvasBlob(canvas, "image/png"));
}
