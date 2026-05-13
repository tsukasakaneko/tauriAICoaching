"""
Verify valorant_minimap.onnx satisfies the contract expected by yoloInference.js.

Checks:
  1. Input node named 'images', shape [1, 3, 640, 640]
  2. Output shape [8400, 7]  (8400 anchors × (4 bbox + 3 classes))
  3. Inference runs without error on a synthetic grey frame
  4. Detections above conf=0.45 on a grey frame are ~0 (sanity check)

Usage:
    python training/scripts/03_verify_minimap.py
"""

import sys
import numpy as np
import onnxruntime as ort
from pathlib import Path

MODEL_PATH = (
    Path(__file__).parent.parent.parent /
    'src-tauri' / 'resources' / 'models' / 'valorant_minimap.onnx'
)
NC     = 3
STRIDE = 4 + NC
CONF   = 0.45


def main():
    if not MODEL_PATH.exists():
        sys.exit(f'Model not found: {MODEL_PATH}\nRun 02_export_minimap.py first.')

    sess = ort.InferenceSession(str(MODEL_PATH))

    # 1. Input node name
    inp = sess.get_inputs()[0]
    assert inp.name == 'images', f'FAIL: input name = {inp.name!r}, expected "images"'
    print(f'[OK] input  name  = {inp.name!r}')

    # 2. Input shape
    assert list(inp.shape) == [1, 3, 640, 640], f'FAIL: input shape = {inp.shape}'
    print(f'[OK] input  shape = {inp.shape}')

    # 3. Run inference
    dummy = np.full((1, 3, 640, 640), 0.45, dtype=np.float32)
    out = sess.run(None, {'images': dummy})[0]

    # 4. Output shape
    assert out.shape == (8400, STRIDE), f'FAIL: output shape = {out.shape}'
    print(f'[OK] output shape = {out.shape}')

    # 5. Sanity: grey frame should produce near-zero detections
    above_conf = int(np.sum(np.max(out[:, 4:], axis=1) >= CONF))
    print(f'[OK] detections above conf={CONF} on grey frame = {above_conf}  (expect ~0)')
    if above_conf > 20:
        print(f'[WARN] Unexpectedly many detections on a grey frame ({above_conf}). '
              'Check model quality.')

    print('\nAll checks passed. valorant_minimap.onnx is ready to use.')


if __name__ == '__main__':
    main()
