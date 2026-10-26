"""The three palette options (source of truth for tokens.json / tokens.css) + WCAG contrast checks.

  python3 assets/brand/tools/palettes.py            # prints contrast table
  python3 assets/brand/tools/palettes.py --tokens   # rewrites ../tokens.json and ../tokens.css
"""

import json
import sys
from pathlib import Path

BRAND = Path(__file__).resolve().parent.parent

# Each option: light + dark colour sets. Keys are the token names (without the --sc- prefix).
PALETTES = {
    "honey": {
        "name": "Honey & Ink",
        "summary": "Warm golden honey on a deep warm ink, cream paper. Friendly and sunny without the lemon-yellow of dating apps or the yellow/black of warning signs.",
        "light": {
            "bg": "#FBF7EF", "surface": "#FFFFFF", "surface-2": "#F4EDE0", "border": "#E8DFCF",
            "ink": "#1D1812", "muted": "#6B6152",
            "accent": "#F29E0C", "on-accent": "#1D1812", "accent-strong": "#8F5300",
            "secondary": "#1D1812", "on-secondary": "#FBF7EF",
            "success": "#257A4A", "warning": "#B45309", "live": "#D7322A", "on-live": "#FFFFFF",
            "danger": "#C42B21", "on-danger": "#FFFFFF", "focus": "#2F6FDB",
        },
        "dark": {
            "bg": "#14110D", "surface": "#1E1A14", "surface-2": "#28221A", "border": "#3A3227",
            "ink": "#F7F1E6", "muted": "#ADA290",
            "accent": "#F5A623", "on-accent": "#1D1812", "accent-strong": "#FFC15E",
            "secondary": "#F7F1E6", "on-secondary": "#14110D",
            "success": "#4CC283", "warning": "#F59E0B", "live": "#FF5247", "on-live": "#1D1812",
            "danger": "#FF6B61", "on-danger": "#14110D", "focus": "#7FA8FF",
        },
    },
    "forest": {
        "name": "Forest & Cream",
        "summary": "Deep pine-teal with a honey highlight on warm cream. Calm, trustworthy, a bit editorial; reads 'nature/hive' without any yellow field.",
        "light": {
            "bg": "#F6F1E6", "surface": "#FFFDF8", "surface-2": "#EEE7D7", "border": "#E1D9C7",
            "ink": "#12211F", "muted": "#58665F",
            "accent": "#0F5C53", "on-accent": "#FFFDF8", "accent-strong": "#0A4740",
            "secondary": "#F2B441", "on-secondary": "#12211F",
            "success": "#3B7A2A", "warning": "#A15C00", "live": "#D63A2F", "on-live": "#FFFFFF",
            "danger": "#B9302A", "on-danger": "#FFFDF8", "focus": "#9A6200",
        },
        "dark": {
            "bg": "#0C1716", "surface": "#13221F", "surface-2": "#1A2D29", "border": "#26403A",
            "ink": "#EEF3EE", "muted": "#9CB0A9",
            "accent": "#3DB5A2", "on-accent": "#0C1716", "accent-strong": "#7DD8C8",
            "secondary": "#F2B441", "on-secondary": "#12211F",
            "success": "#7BC86A", "warning": "#F2B441", "live": "#FF5A4E", "on-live": "#0C1716",
            "danger": "#FF7A70", "on-danger": "#0C1716", "focus": "#F2B441",
        },
    },
    "onair": {
        "name": "On Air",
        "summary": "Signal vermilion (the studio 'on air' lamp) with charcoal and warm paper, honey as a small highlight. Bold and energetic; the brand colour itself means live.",
        "light": {
            "bg": "#F7F4EF", "surface": "#FFFFFF", "surface-2": "#EFEAE2", "border": "#E4DED4",
            "ink": "#1C1B1A", "muted": "#64605A",
            "accent": "#FF5A1F", "on-accent": "#1C1B1A", "accent-strong": "#B83A0B",
            "secondary": "#1C1B1A", "on-secondary": "#F7F4EF",
            "success": "#1E7F4E", "warning": "#A86200", "live": "#FF5A1F", "on-live": "#1C1B1A",
            "danger": "#C2261C", "on-danger": "#FFFFFF", "focus": "#2F6FDB",
        },
        "dark": {
            "bg": "#121212", "surface": "#1C1B1A", "surface-2": "#262422", "border": "#36332F",
            "ink": "#F5F2ED", "muted": "#A6A199",
            "accent": "#FF6A33", "on-accent": "#121212", "accent-strong": "#FF9466",
            "secondary": "#F5F2ED", "on-secondary": "#121212",
            "success": "#4CC283", "warning": "#FFB547", "live": "#FF6A33", "on-live": "#121212",
            "danger": "#FF6B61", "on-danger": "#121212", "focus": "#7FA8FF",
        },
    },
}

# Illustration colours of the symbol / mascot for the chosen palette (Forest).
ILLUSTRATION = {
    "honey": "#F2B441",  # bee body
    "pine": "#0F5C53",  # waves, headset
    "pine-deep": "#0F3D38",  # stripes, eyes, outlines
    "cream": "#F6F1E6",  # face, waves on dark/pine backgrounds
    "comment": "Symbol and mascot colours (Forest). On dark or pine backgrounds the waves and antennae use cream.",
}


def lum(hex_):
    h = hex_.lstrip("#")
    rgb = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted([lum(a), lum(b)], reverse=True)
    return (la + 0.05) / (lb + 0.05)


def mix(a, b, t):
    """t of colour a over (1-t) of colour b, in sRGB, as #RRGGBB."""
    pa = [int(a.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4)]
    pb = [int(b.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x * t + y * (1 - t)):02X}" for x, y in zip(pa, pb))


def _derive():
    """Derived tokens: text (ink 88% into bg), border-strong (>= 3:1 on surface), accent-soft (tint)."""
    for pal in PALETTES.values():
        for mode in ("light", "dark"):
            p = pal[mode]
            p["text"] = mix(p["ink"], p["bg"], 0.88)
            t = 0.2
            while contrast(mix(p["ink"], p["surface"], t), p["surface"]) < 3.0 and t < 1:
                t += 0.01
            p["border-strong"] = mix(p["ink"], p["surface"], t)
            p["accent-soft"] = mix(p["accent"], p["surface"], 0.12 if mode == "light" else 0.2)


PAIRS = [
    ("text", "bg"), ("border-strong", "surface"), ("accent-strong", "accent-soft"),
    ("ink", "bg"), ("ink", "surface"), ("muted", "surface"), ("on-accent", "accent"), ("accent-strong", "surface"),
    ("accent", "bg"), ("on-live", "live"), ("danger", "surface"), ("success", "surface"), ("warning", "surface"),
    ("on-secondary", "secondary"), ("on-danger", "danger"), ("focus", "bg"),
]


def grade(c):
    return "AAA" if c >= 7 else "AA" if c >= 4.5 else "AA-large/UI" if c >= 3 else "FAIL"


_derive()


def contrast_report(key):
    out = {}
    for mode in ("light", "dark"):
        p = PALETTES[key][mode]
        out[mode] = [(f"{a} on {b}", round(contrast(p[a], p[b]), 2), grade(contrast(p[a], p[b]))) for a, b in PAIRS]
    return out


TYPE = {
    "font-family": "'Fredoka', 'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "font-family-text": "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "font-family-ui": "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    "font-family-mono": "ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
    "weights": {"regular": 400, "medium": 500, "semibold": 600, "bold": 700},
    "note": "Fredoka (SIL OFL 1.1) is display only: the wordmark, small headings, big numbers, the mascot's speech. "
    "Body text, large headlines and UI use Inter (self-hosted, SIL OFL 1.1); --sc-font-ui is the no-download fallback.",
    "files": "assets/brand/font/Fredoka-VF.ttf (variable, wght 300-700) and Fredoka-SemiBold.ttf; licence assets/brand/font/OFL.txt",
}
RADII = {"sm": "6px", "md": "10px", "lg": "16px", "xl": "24px", "pill": "999px"}
SHADOW = {
    "policy": "flat: no decorative shadows. Use borders and surface steps; one soft shadow only for floating layers (menus, dialogs, toasts).",
    "none": "none",
    "float": "0 8px 24px rgba(0,0,0,.12)",
    "float-dark": "0 8px 24px rgba(0,0,0,.5)",
}


def write_tokens(default="forest"):
    data = {
        "$comment": "SwarmCast design tokens. Single source of truth for the panel, desktop shell, website and icons. "
        "Generated by assets/brand/tools/palettes.py; edit there. `default` is the palette in use.",
        "default": default,
        "palettes": {
            k: {"name": v["name"], "summary": v["summary"], "light": v["light"], "dark": v["dark"],
                "contrast": contrast_report(k)}
            for k, v in PALETTES.items()
        },
        "illustration": ILLUSTRATION,
        "type": TYPE,
        "radius": RADII,
        "shadow": SHADOW,
        "space": {"1": "4px", "2": "8px", "3": "12px", "4": "16px", "5": "24px", "6": "32px", "7": "48px"},
    }
    (BRAND / "tokens.json").write_text(json.dumps(data, indent=2) + "\n")

    def block(sel, colors, extra=""):
        lines = [f"{sel} {{"] + [f"  --sc-{k}: {v};" for k, v in colors.items()] + ([extra] if extra else []) + ["}"]
        return "\n".join(lines)

    common = "\n".join(
        [
            ":root {",
            f"  --sc-font: {TYPE['font-family']};",
            "  --sc-font-display: var(--sc-font);",
            f"  --sc-font-text: {TYPE['font-family-text']};",
            f"  --sc-font-ui: {TYPE['font-family-ui']};",
            f"  --sc-font-mono: {TYPE['font-family-mono']};",
        ]
        + [f"  --sc-weight-{k}: {v};" for k, v in TYPE["weights"].items()]
        + [f"  --sc-radius-{k}: {v};" for k, v in RADII.items()]
        + ["  --sc-shadow: none;", f"  --sc-shadow-float: {SHADOW['float']};", "}"]
    )
    css = [
        "/* SwarmCast design tokens. Generated by assets/brand/tools/palettes.py (edit there).",
        f" * Default palette: {PALETTES[default]['name']}. Other options: <html data-palette=\"honey|onair\">;",
        " * force a theme with <html data-theme=\"light|dark\">, otherwise prefers-color-scheme decides. */",
        "",
        common,
        "",
    ]
    for k, v in PALETTES.items():
        p = f':root[data-palette="{k}"]'
        light_sel = f":root, {p}" if k == default else p
        dark_sel = f':root[data-theme="dark"], {p}[data-theme="dark"]' if k == default else f'{p}[data-theme="dark"]'
        auto = f'{p}:not([data-theme="light"])'
        if k == default:
            auto = f':root:not([data-theme="light"]):not([data-palette]), {auto}'
        dark_extra = "  color-scheme: dark;\n  --sc-shadow-float: " + SHADOW["float-dark"] + ";"
        css.append(f"/* {v['name']} */")
        css.append(block(light_sel, v["light"], "  color-scheme: light;"))
        css.append(block(dark_sel, v["dark"], dark_extra))
        css.append("@media (prefers-color-scheme: dark) {\n" + "\n".join("  " + l for l in block(auto, v["dark"], dark_extra).splitlines()) + "\n}")
        css.append("")
    (BRAND / "tokens.css").write_text("\n".join(css))


if __name__ == "__main__":
    if "--tokens" in sys.argv:
        write_tokens()
        print("wrote tokens.json, tokens.css")
    for k in PALETTES:
        print(f"== {PALETTES[k]['name']}")
        for mode, rows in contrast_report(k).items():
            print("  ", mode, "; ".join(f"{a} {c} {g}" for a, c, g in rows))
