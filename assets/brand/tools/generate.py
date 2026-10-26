"""Batch image generation for the SwarmCast brand explorations (mflux 0.23.0).

Keeps one model loaded and runs every job in one or more JSON job files. Existing outputs are
skipped, so the script can be re-run after an interruption.

Run with the Python of the mflux uv tool:
  ~/.local/share/uv/tools/mflux/bin/python assets/brand/tools/generate.py \
      --model qwen assets/brand/tools/prompts/round1.json

Job file format:
  {"defaults": {"width": 1024, "height": 1024, "steps": 30, "guidance": 4.0, "negative": "..."},
   "jobs": [{"id": "A1", "dir": "A", "prompt": "...", "seeds": [1, 2, 3]}]}
"""

import argparse
import json
import sys
import time
from pathlib import Path

OUT_ROOT = Path(__file__).resolve().parent.parent / "explorations" / "raw"


def load_model(name: str, quantize: int | None):
    from mflux.models.common.config import ModelConfig

    if name == "qwen":
        from mflux.models.qwen.variants.txt2img.qwen_image import QwenImage

        # Pre-quantized (q8) MLX conversion of Qwen/Qwen-Image-2512, Apache-2.0, not gated.
        return QwenImage(model_path="mflux-community/qwen-image-2512-mflux-q8", model_config=ModelConfig.qwen_image())
    if name == "zimage":
        from mflux.models.z_image import ZImageTurbo

        # Pre-quantized (q8) MLX conversion of Tongyi-MAI/Z-Image-Turbo, Apache-2.0, not gated.
        return ZImageTurbo(model_path="mflux-community/z-image-turbo-mflux-q8", model_config=ModelConfig.z_image_turbo())
    raise SystemExit(f"unknown model {name}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=["qwen", "zimage"], default="qwen")
    ap.add_argument("--quantize", type=int, default=8)
    ap.add_argument("--only", nargs="*", help="job ids to run")
    ap.add_argument("files", nargs="+")
    args = ap.parse_args()

    work = []
    for f in args.files:
        spec = json.loads(Path(f).read_text())
        d = spec.get("defaults", {})
        for job in spec["jobs"]:
            if args.only and job["id"] not in args.only:
                continue
            j = {**d, **job}
            for seed in j["seeds"]:
                out = OUT_ROOT / j["dir"] / f"{args.model}_{j['id']}_s{seed}.png"
                if not out.exists():
                    work.append((j, seed, out))
    print(f"{len(work)} images to generate", flush=True)
    if not work:
        return
    model = load_model(args.model, args.quantize)
    for i, (j, seed, out) in enumerate(work, 1):
        t = time.time()
        kw = dict(
            seed=seed,
            prompt=j["prompt"],
            num_inference_steps=j.get("steps", 30) if args.model == "qwen" else j.get("zsteps", 9),
            width=j.get("width", 1024),
            height=j.get("height", 1024),
        )
        if args.model == "qwen":
            kw["guidance"] = j.get("guidance", 4.0)
            if j.get("negative"):
                kw["negative_prompt"] = j["negative"]
        img = model.generate_image(**kw)
        out.parent.mkdir(parents=True, exist_ok=True)
        img.image.save(out)
        meta = {"model": args.model, "quantize": args.quantize, "seed": seed, **{k: v for k, v in j.items() if k != "seeds"}}
        out.with_suffix(".json").write_text(json.dumps(meta, indent=1))
        print(f"[{i}/{len(work)}] {out.name} {time.time() - t:.0f}s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
