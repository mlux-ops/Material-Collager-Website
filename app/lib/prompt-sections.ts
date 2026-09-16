export function assembleSections(sections: Array<{ heading: string; body: string } | null | undefined>): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (!section || !section.body) continue;
    parts.push(`${section.heading}\n${section.body}`);
  }
  return parts.join("\n\n");
}

function supportingRange(start: number, end: number): string {
  return start === end ? `Image ${start}` : `Images ${start}-${end}`;
}

export function buildReferenceMap(refs: Array<{ role: string; label?: string; supportingViews?: number }>): string {
  const lines: string[] = [];
  let next = 1;
  for (const ref of refs) {
    const supportingViews = ref.supportingViews ?? 0;
    const start = next;
    const end = start + supportingViews;
    next = end + 1;

    const details = [
      `role: ${ref.role}`,
      ref.label ? `label: ${ref.label}` : null,
      // A bare multi-image range reads as several things to place, so the model
      // renders the extra views as extra objects on the canvas; spelling out
      // which image carries identity and which are supporting views of that
      // same item is what stops it (collage.ts:380-385, where this originates).
      supportingViews > 0 ? `primary identity view: Image ${start}` : null,
      supportingViews > 0 ? `supporting views of this same physical item: ${supportingRange(start + 1, end)}` : null,
    ].filter(Boolean);

    lines.push(`${supportingRange(start, end)} -> ${details.join("; ")}`);
  }
  return lines.join("\n");
}

export function changeScopeLines(input: {
  change: string;
  preserve?: string[];
  exclusions?: string[];
}): { heading: string; body: string }[] {
  const sections: { heading: string; body: string }[] = [{ heading: "CHANGE", body: `Change ONLY ${input.change}.` }];

  if (input.preserve && input.preserve.length > 0) {
    sections.push({
      heading: "PRESERVE",
      body: `Preserve ${input.preserve.join(", ")}. Keep all other aspects of the image unchanged.`,
    });
  }

  if (input.exclusions && input.exclusions.length > 0) {
    sections.push({ heading: "EXCLUSIONS", body: `Do not add ${input.exclusions.join(", ")}.` });
  }

  return sections;
}
