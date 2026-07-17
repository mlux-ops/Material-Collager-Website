# Console and context recovery

- Date:
- Release-candidate commit:
- Staging URL:
- Browser/device:
- GPU renderer:

## Context-loss procedure

1. Load the populated Library and allow all visible previews to settle.
2. Trigger or simulate WebGL context loss.
3. Confirm the fallback state is readable and the semantic collection remains usable.
4. Restore the context.
5. Repeat selection, drag, Scene/Index, preview, and Close.
6. Repeat the loss/restore cycle at least twice.

## Results

- Texture-upload warnings observed:
- Warning text or screenshot:
- Missing textures after restore:
- Frozen interaction:
- Reload required:
- Memory/GPU growth observed:
- Final result: Pending
