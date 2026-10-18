#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
refine-beats.py —— 用专业节拍跟踪器精修卡点表（精度模式）

为什么需要它：
    beat.mjs 是纯 Node、零依赖的实现，快、能跑在任意机器上，但它用的是
    "帧起始对齐"的简易包络，实测在合成点击轨上比真实音头**早约 24ms**，
    在混响很重的 vibe.mp3 上早约 34–40ms（一帧 33ms，肉眼可见）。
    librosa 的 DP 跟踪器（Ellis 2007）跑在标定过的 mel 起音包络上，
    对齐误差小得多；再用抛物线插值把每个网格点吸到包络峰，可以到亚帧精度。

实测（vibe.mp3，同一套度量：拍点处起音包络 / 全帧均值）：
    旧表 302 拍      峰位 +40ms   峰背比 3.63
    librosa DP 原始  峰位  -8ms   峰背比 5.40
    精修网格         峰位   0ms   峰背比 5.53   ← 最佳

用法：
    uv venv --python 3.12 .venv && uv pip install --python .venv librosa soundfile
    .venv/Scripts/python.exe scripts/refine-beats.py \
        --audio assets/bgm/vibe.mp3 --out assets/beats.json

参数：
    --audio   音频文件
    --out     输出卡点表（默认 assets/beats.json）
    --bpm     BPM 提示，防半数/倍数跳跃（默认读 out 文件里的 bpm，否则 120）
    --every   few beats 一个重拍（默认 16，与 8.5s 一圈的乐句一致）
    --dry-run 只打印对比，不写文件

依赖：librosa + soundfile + numpy（只在精修时需要，日常 build 不需要）
"""

import argparse
import hashlib
import json
import os
import sys

import numpy as np

try:
    import librosa
    import soundfile as sf
except ImportError:
    sys.exit("需要 librosa / soundfile：uv pip install librosa soundfile")

SR = 22050
HOP = 128
FPS = SR / HOP


def load_mono(path):
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y


def onset_env(y):
    e = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    return e / (e.max() + 1e-12)


def profile(beats, env, span=0.15, step=0.002):
    """拍点前后 ±span 的平均包络：峰位越接近 0、峰背比越高，对齐越好"""
    offs = np.arange(-span, span + 1e-9, step)
    vals = []
    for s in offs:
        i = np.round((beats + s) * FPS).astype(int)
        i = i[(i >= 0) & (i < len(env))]
        vals.append(env[i].mean() if len(i) else 0.0)
    vals = np.array(vals)
    k = int(np.argmax(vals))
    return offs[k] * 1000, float(vals[k]), float(vals[k] / env.mean())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default="assets/bgm/vibe.mp3")
    ap.add_argument("--out", default="assets/beats.json")
    ap.add_argument("--prev", default="assets/beats.json", help="旧表，用于继承元数据与打印对比")
    ap.add_argument("--bpm", type=float, default=None)
    ap.add_argument("--every", type=int, default=16)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    audio_bytes = open(a.audio, "rb").read()
    md5 = hashlib.md5(audio_bytes).hexdigest()

    old = {}
    prev = a.prev if os.path.exists(a.prev) else (a.out if os.path.exists(a.out) else None)
    if prev:
        old = json.load(open(prev, encoding="utf-8"))
    hint = a.bpm or old.get("bpm") or 120.0

    y = load_mono(a.audio)
    dur = len(y) / SR
    env = onset_env(y)

    # ① DP 跟踪：在给定 BPM 附近解码最优拍序列
    _, bp = librosa.beat.beat_track(
        onset_envelope=env, sr=SR, hop_length=HOP, bpm=hint, tightness=150, trim=False
    )
    dp = librosa.frames_to_time(bp, sr=SR, hop_length=HOP)
    dp = dp[(dp > 1.0) & (dp < dur - 1.0)]
    if len(dp) < 8:
        sys.exit("[refine] DP 只给出不到 8 拍，这条音频可能没有稳定节拍")

    # ② 稳健线性拟合，拿拍长（迭代剔除离群点）
    idx = np.arange(len(dp))
    keep = np.ones(len(idx), bool)
    for _ in range(3):
        coef = np.polyfit(idx[keep], dp[keep], 1)
        r = np.abs(dp - (coef[0] * idx + coef[1]))
        keep = r <= np.percentile(r, 90)
    period = float(coef[0])

    # ③ 相位扫描：让网格点落在包络最强的位置
    best = (-1.0, 0.0)
    for ph in np.arange(0, 1, 0.002):
        g = np.arange(coef[1] + ph * period, dur, period)
        g = g[(g > 0) & (g < dur)]
        i = np.round(g * FPS).astype(int)
        i = i[i < len(env)]
        if not len(i):
            continue
        s = float(env[i].mean())
        if s > best[0]:
            best = (s, ph)
    phase = (coef[1] + best[1] * period) % period
    grid = np.arange(phase, dur, period)
    grid = grid[(grid > 0.02) & (grid < dur - 0.05)]

    # ④ 逐拍吸附：±20ms 找峰 + 抛物线插值到亚帧
    span = int(round(0.02 * FPS))
    snapped = []
    for t in grid:
        c = int(round(t * FPS))
        lo, hi = max(1, c - span), min(len(env) - 2, c + span + 1)
        if hi <= lo:
            snapped.append(float(t))
            continue
        k = lo + int(np.argmax(env[lo:hi]))
        y0, y1, y2 = env[k - 1], env[k], env[k + 1]
        den = y0 - 2 * y1 + y2
        off = float(np.clip(0.5 * (y0 - y2) / den, -0.5, 0.5)) if abs(den) > 1e-9 else 0.0
        snapped.append((k + off) / FPS)
    snapped = np.array(snapped)

    print(f"[refine] DP {len(dp)} 拍 · 拍长 {period:.6f}s（{60/period:.3f} BPM）")
    print(f"[refine] 相位 {phase:.4f}s · 网格 {len(grid)} 点 · {a.every} 拍 = {a.every*period:.3f}s")
    for name, b in [("旧表", np.array(old.get("onsets", []))), ("DP 原始", dp), ("精修网格", snapped)]:
        if not len(b):
            continue
        o, _, rt = profile(b, env)
        print(f"[refine] {name:6s} n={len(b):3d}  峰位 {o:+6.1f}ms  峰背比 {rt:5.2f}")

    data = dict(old)

    def level(beats, offset=0.0):
        i = np.round((np.array(beats) + offset) * FPS).astype(int)
        i = i[(i >= 0) & (i < len(env))]
        return float(env[i].mean()) if len(i) else 0.0

    on_grid = level(snapped)
    half = level(snapped, period / 2)
    ratio = on_grid / half if half > 1e-9 else float("inf")

    data.update({
        "audio": os.path.basename(a.audio),
        "audioMd5": md5,
        "audioBytes": len(audio_bytes),
        "duration": round(dur, 2),
        "bpm": round(60 / period, 2),
        "period": round(period, 5),
        "phase": round(phase, 4),
        "onsets": [round(float(t), 3) for t in snapped],
        "strong": [round(float(t), 3) for t in snapped[::a.every]],
        "strongEvery": a.every,
        "density": round(len(snapped) / dur, 2),
        "onGrid": round(on_grid, 3),
        "halfBeat": round(half, 3),
        "contrast": round(on_grid - half, 3),
        "ratio": round(ratio, 2) if np.isfinite(ratio) else 99,
        "refinedBy": "librosa.beat_track(DP) + 抛物线插值吸附",
    })
    gaps = np.diff(np.array(data["strong"]))
    print(f"[refine] 圈头 {len(data['strong'])} 个 · 间隔中位 {np.median(gaps):.3f}s")

    if a.dry_run:
        print("[refine] dry-run，未写文件")
        return
    json.dump(data, open(a.out, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"[refine] 已写入 {a.out}")


if __name__ == "__main__":
    main()
