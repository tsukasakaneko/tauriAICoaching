"""
Train the valorant_minimap YOLOv8 detection model.

Usage (from repo root):
    python training/scripts/01_train_minimap.py

Accuracy targets before exporting:
    - val mAP@0.5 (player_dot class) >= 0.70   (minimum)
    - val mAP@0.5 (player_dot class) >= 0.85   (goal)

If mAP is below the minimum after 100 epochs:
    1. Add ~200 more annotated images and retrain.
    2. If still below target, change YOLO('yolov8n.pt') to YOLO('yolov8s.pt').
"""

from pathlib import Path
from ultralytics import YOLO

CONFIG = Path(__file__).parent.parent / 'config' / 'valorant_minimap.yaml'
RUNS   = Path(__file__).parent.parent / 'runs'

def main():
    if not CONFIG.exists():
        raise FileNotFoundError(f'Missing config: {CONFIG}')

    data_dir = Path(__file__).parent.parent / 'data' / 'minimap'
    if not data_dir.exists():
        raise FileNotFoundError(
            f'No training data at {data_dir}. Run 00_download_dataset.py first.')

    model = YOLO('yolov8n.pt')
    results = model.train(
        task='detect',
        data=str(CONFIG),
        epochs=100,
        imgsz=640,
        batch=16,
        name='valorant_minimap',
        project=str(RUNS),
        # Minimap orientation is fixed (north = spawn side) — no horizontal flip
        fliplr=0.0,
        # Allow brightness variation for different monitor calibrations
        hsv_v=0.3,
        hsv_s=0.4,
        mosaic=0.5,
        copy_paste=0.1,
        # Match thresholds used by yoloInference.js
        iou=0.5,
        conf=0.45,
    )

    best = RUNS / 'valorant_minimap' / 'weights' / 'best.pt'
    print(f'\nTraining complete. Best weights: {best}')
    print('Run 02_export_minimap.py to convert to ONNX.')

if __name__ == '__main__':
    main()
