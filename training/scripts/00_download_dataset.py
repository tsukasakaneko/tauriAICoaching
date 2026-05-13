"""
Download valorant_minimap dataset from Roboflow Universe.

Usage:
    export ROBOFLOW_API_KEY=your_key_here
    python training/scripts/00_download_dataset.py

The script downloads to training/data/minimap/ in YOLOv8 format.
If a suitable public dataset isn't found, annotate your own screenshots
using https://app.roboflow.com and export in YOLOv8 format.

Required classes (in this order — must match valorant_minimap.yaml):
    0: minimap_region
    1: player_dot
    2: enemy_dot
"""

import os
import sys
from pathlib import Path

WORKSPACE  = os.environ.get('ROBOFLOW_WORKSPACE', '')
PROJECT    = os.environ.get('ROBOFLOW_PROJECT', 'valorant-minimap')
VERSION    = int(os.environ.get('ROBOFLOW_VERSION', '1'))
OUTPUT_DIR = Path(__file__).parent.parent / 'data' / 'minimap'

def main():
    api_key = os.environ.get('ROBOFLOW_API_KEY', '')
    if not api_key:
        sys.exit('Set ROBOFLOW_API_KEY environment variable before running.')

    try:
        from roboflow import Roboflow
    except ImportError:
        sys.exit('Run: pip install -r training/requirements.txt')

    rf = Roboflow(api_key=api_key)

    if WORKSPACE:
        project = rf.workspace(WORKSPACE).project(PROJECT)
    else:
        # Search public universe for a suitable dataset
        print('No ROBOFLOW_WORKSPACE set — searching Roboflow Universe...')
        print('Visit https://universe.roboflow.com and search "valorant minimap"')
        print('Then set ROBOFLOW_WORKSPACE and ROBOFLOW_PROJECT and re-run.')
        sys.exit(1)

    dataset = project.version(VERSION).download('yolov8', location=str(OUTPUT_DIR))
    print(f'\nDataset downloaded to: {OUTPUT_DIR}')

    # Print class distribution
    for split in ('train', 'valid', 'test'):
        label_dir = OUTPUT_DIR / split / 'labels'
        if not label_dir.exists():
            continue
        counts = {0: 0, 1: 0, 2: 0}
        for f in label_dir.glob('*.txt'):
            for line in f.read_text().splitlines():
                cls = int(line.split()[0])
                counts[cls] = counts.get(cls, 0) + 1
        names = ['minimap_region', 'player_dot', 'enemy_dot']
        print(f'{split}: ' + ', '.join(f'{names[c]}={n}' for c, n in counts.items()))

if __name__ == '__main__':
    main()
