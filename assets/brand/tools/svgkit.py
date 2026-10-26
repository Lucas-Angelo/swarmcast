"""Small geometry helpers for the hand-built SVGs (rounded polygons, number formatting)."""

import math


def n(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


def rounded_polygon(points, radius, close=True):
    """Path data for a polygon whose corners are rounded with circular arcs of `radius`.

    `radius` can be a number or a list (one per corner)."""
    k = len(points)
    radii = radius if isinstance(radius, (list, tuple)) else [radius] * k
    segs = []
    for i in range(k):
        p0, p1, p2 = points[i - 1], points[i], points[(i + 1) % k]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        u1 = (v1[0] / l1, v1[1] / l1)
        u2 = (v2[0] / l2, v2[1] / l2)
        ang = math.acos(max(-1, min(1, u1[0] * u2[0] + u1[1] * u2[1])))
        r = radii[i]
        t = r / math.tan(ang / 2)  # distance from corner to tangent points
        a = (p1[0] + u1[0] * t, p1[1] + u1[1] * t)
        b = (p1[0] + u2[0] * t, p1[1] + u2[1] * t)
        cross = u1[0] * u2[1] - u1[1] * u2[0]
        sweep = 0 if cross > 0 else 1
        segs.append((a, b, r, sweep))
    d = f"M{n(segs[0][1][0])} {n(segs[0][1][1])}"
    for i in range(1, k + 1):
        a, b, r, sweep = segs[i % k]
        d += f"L{n(a[0])} {n(a[1])}A{n(r)} {n(r)} 0 0 {sweep} {n(b[0])} {n(b[1])}"
    return d + ("Z" if close else "")


def regular_polygon(cx, cy, r, k, rot_deg=0):
    return [
        (cx + r * math.cos(math.radians(rot_deg + 360 * i / k)), cy + r * math.sin(math.radians(rot_deg + 360 * i / k)))
        for i in range(k)
    ]
