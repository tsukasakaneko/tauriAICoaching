'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');

// 録画MP4のライフサイクル管理。ポリシーは「解析成功分はすべて保持」。
// 削除するのは (a) 解析に失敗した録画、(b) クラッシュ/途中停止で残った
// 部分ファイル(起動時 sweep)のみ。
// 注意: 1つの録画ファイルを複数ユーザーのセッションが共有参照するため、
// 削除・参照クリアは常に「ファイルパス単位」で行う。

const DATA_DIR = path.join(os.homedir(), '.local', 'share', 'valorant-ai-coaching');

// ファイルを削除し、参照している全セッションの recording_path を NULL にする。
// ENOENT(既に無い)は成功扱い。
function deleteRecording(recordingPath) {
  if (!recordingPath) return;
  try {
    fs.unlinkSync(recordingPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[retention] failed to delete recording:', err.message);
      return; // ファイルが残っている間は参照も残す(次回 sweep で回収)
    }
  }
  db.prepare('UPDATE match_sessions SET recording_path = NULL WHERE recording_path = ?')
    .run(recordingPath);
}

// 起動時: dataDir の match_*.mp4 のうち、done セッションから参照されていない
// ファイル(未参照、または録画中/エラーのまま残ったもの)を回収する。
// サーバー起動時に録画中はあり得ないので安全。done の録画は削除しない。
function sweepStaleRecordings(dataDir = DATA_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return 0;
  }

  const doneCount = db.prepare(
    `SELECT COUNT(*) AS n FROM match_sessions WHERE recording_path = ? AND status = 'done'`
  );

  let removed = 0;
  for (const name of entries) {
    if (!/^match_.*\.mp4$/.test(name)) continue;
    const fullPath = path.join(dataDir, name);
    if (doneCount.get(fullPath).n > 0) continue; // 保持対象
    deleteRecording(fullPath);
    removed++;
  }
  return removed;
}

module.exports = { deleteRecording, sweepStaleRecordings, DATA_DIR };
