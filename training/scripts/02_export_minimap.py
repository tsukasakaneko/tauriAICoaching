"""
Export valorant_minimap weights to ONNX and fix the output tensor layout.

YOLOv8 natively exports detection output as [1, 4+nc, 8400] (channel-first).
yoloInference.js parseDetections() reads the flat buffer as row-major [N, 4+nc].
This script appends Transpose + Reshape nodes so the ONNX file itself outputs
[8400, 7] (for nc=3), matching what the JS code expects — no JS change needed.

Usage (from repo root):
    python training/scripts/02_export_minimap.py
"""

import numpy as np
import onnx
import onnxsim
from onnx import helper, TensorProto, numpy_helper
from pathlib import Path
from ultralytics import YOLO

NC       = 3   # minimap_region, player_dot, enemy_dot
RUNS_DIR = Path(__file__).parent.parent / 'runs'
OUT_DIR  = Path(__file__).parent.parent.parent / 'src-tauri' / 'resources' / 'models'


def append_transpose_reshape(proto, nc):
    """Append Transpose([0,2,1]) + Reshape to [8400, 4+nc] after the detection head."""
    out_name = proto.graph.output[0].name
    stride = 4 + nc

    transposed = out_name + '_T'
    proto.graph.node.append(
        helper.make_node('Transpose', [out_name], [transposed], perm=[0, 2, 1]))

    shape_name = 'reshape_target_shape'
    shape_init = numpy_helper.from_array(
        np.array([8400, stride], dtype=np.int64), shape_name)
    proto.graph.initializer.append(shape_init)

    reshaped = out_name + '_R'
    proto.graph.node.append(
        helper.make_node('Reshape', [transposed, shape_name], [reshaped]))

    new_out = helper.make_tensor_value_info(reshaped, TensorProto.FLOAT, [8400, stride])
    del proto.graph.output[:]
    proto.graph.output.append(new_out)
    return proto


def main():
    best_pt = RUNS_DIR / 'valorant_minimap' / 'weights' / 'best.pt'
    if not best_pt.exists():
        raise FileNotFoundError(f'Missing weights: {best_pt}\nRun 01_train_minimap.py first.')

    print(f'Exporting {best_pt} ...')
    model = YOLO(str(best_pt))
    model.export(format='onnx', imgsz=640, opset=11, simplify=True, dynamic=False)

    exported = best_pt.with_suffix('.onnx')
    assert exported.exists(), f'ultralytics export failed: {exported}'

    proto = onnx.load(str(exported))

    # ── Assertions on raw export ──────────────────────────────────────────────
    input_names = [i.name for i in proto.graph.input]
    assert 'images' in input_names, f"Input node not named 'images': {input_names}"

    in_shape = [d.dim_value for d in proto.graph.input[0].type.tensor_type.shape.dim]
    assert in_shape == [1, 3, 640, 640], f'Unexpected input shape: {in_shape}'

    raw_out_shape = [d.dim_value for d in proto.graph.output[0].type.tensor_type.shape.dim]
    assert raw_out_shape == [1, 4 + NC, 8400], \
        f'Unexpected raw output shape: {raw_out_shape}. Is this YOLOv8 detect?'

    print(f'[OK] input  = images {in_shape}')
    print(f'[OK] raw output = {raw_out_shape}')

    # ── Append layout fix and re-simplify ─────────────────────────────────────
    proto = append_transpose_reshape(proto, NC)
    proto, ok = onnxsim.simplify(proto)
    assert ok, 'onnxsim failed after Transpose+Reshape injection'

    final_shape = [d.dim_value for d in proto.graph.output[0].type.tensor_type.shape.dim]
    assert final_shape == [8400, 4 + NC], f'Final output shape wrong: {final_shape}'
    print(f'[OK] final output = {final_shape}')

    # ── Save ──────────────────────────────────────────────────────────────────
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = OUT_DIR / 'valorant_minimap.onnx'
    onnx.save(proto, str(dest))
    size_mb = dest.stat().st_size / 1_048_576
    print(f'\n[SAVED] {dest}  ({size_mb:.1f} MB)')
    print('Run 03_verify_minimap.py to validate before use.')


if __name__ == '__main__':
    main()
