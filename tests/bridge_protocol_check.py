"""Integration check for the phone-side Mode C protocol (ADR 0003 + FUSED_AXES).

Runs the real MappingEngine against a config shaped like the shipped one: the phone sends
'fused_vibrato' pitch-bend values, which must (a) not be re-smoothed by the bridge, (b) pick
up the mapping's target type, and (c) be change-detected at 14-bit precision.
"""
import json, sys, tempfile, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))
import server

CFG = {
    "preset_name": "test", "mappings": [{
        "source": {"sensor": "motion", "axis": "fused_vibrato"},
        "target": {"type": "pb", "cc": None, "channel": 0},
        "range": {"in_min": 0.0, "in_max": 1.0, "out_min": 0, "out_max": 127, "dead_zone": 0.45},
        "curve": {"type": "linear"},
        "smoothing": {"type": "ema", "alpha": 0.15},
    }],
}
fails = []
def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name.ljust(46) + detail)
    if not ok:
        fails.append(name)

fd, path = tempfile.mkstemp(suffix=".json"); os.close(fd)
with open(path, "w", encoding="utf-8") as f:
    json.dump(CFG, f)
try:
    eng = server.MappingEngine(path)

    check("bridge: fused_vibrato is in FUSED_AXES", "fused_vibrato" in server.FUSED_AXES,
          f"FUSED_AXES={server.FUSED_AXES}")

    # The dead zone must be skipped: the phone already centred the value in count space.
    outs = eng.process("motion", "fused_vibrato", 0.5 + 0.15, kind_override="pb")
    check("bridge: dead zone not re-applied", len(outs) == 1 and outs[0][4] == 0.65,
          f"in 0.65 -> {outs}")

    # Same input twice: the second call must be swallowed by the change detector.
    again = eng.process("motion", "fused_vibrato", 0.5 + 0.15, kind_override="pb")
    check("bridge: unchanged value is not re-sent", again == [], f"{again}")

    # One 14-bit count of movement must get through (16383 resolution for pb).
    step = eng.process("motion", "fused_vibrato", 0.5 + 0.15 + 1 / 16383, kind_override="pb")
    check("bridge: 14-bit resolution preserved", len(step) == 1,
          f"one count -> {len(step)} output(s)")

    # Centre must map to exactly 8192 through the shared conversion.
    eng.reset()
    centre = eng.process("motion", "fused_vibrato", 0.5, kind_override="pb")
    check("bridge: centre is exactly 8192",
          centre and centre[0][4] == 0.5 and server.pb_from_norm(centre[0][4]) == 8192,
          f"norm {centre[0][4]} -> pb {server.pb_from_norm(centre[0][4])}")
    check("bridge: pb endpoints and round-trip",
          (server.pb_from_norm(0.0), server.pb_from_norm(1.0)) == (0, 16383)
          and server.pb_from_norm(0.5 + 30 / 400) == 8192 + 1229,
          f"0->{server.pb_from_norm(0.0)}, 1->{server.pb_from_norm(1.0)}, "
          f"+30 cents->{server.pb_from_norm(0.5 + 30 / 400)} (+{server.pb_from_norm(0.5 + 30 / 400) - 8192} counts)")

    # Explicit kind overrides the mapping only when present; without it the mapping's
    # target.type is used.
    eng.reset()
    no_override = eng.process("motion", "fused_vibrato", 0.75)
    check("bridge: falls back to the mapping's target type",
          no_override and no_override[0][0] == "pb", f"{no_override}")

    # A mapping that targets a CC is unaffected by the vibrato axis.
    eng.mappings[0]["target"]["type"] = "cc"
    eng.reset()
    as_cc = eng.process("motion", "fused_vibrato", 0.75, kind_override="cc")
    check("bridge: a cc target still works on this axis",
          as_cc and as_cc[0][0] == "cc" and as_cc[0][3] == 95, f"{as_cc}")
    eng.mappings[0]["target"]["type"] = "pb"

    # A quiet vibrato must survive the change detector: one count of movement.
    eng.reset()
    eng.process("motion", "fused_vibrato", 0.5)
    tiny = eng.process("motion", "fused_vibrato", 0.5 + 0.5 / 16383)
    check("bridge: sub-count change is filtered", tiny == [], f"{tiny}")
    onestep = eng.process("motion", "fused_vibrato", 0.5 + 1.5 / 16383)
    check("bridge: one count passes", len(onestep) == 1, f"{len(onestep)} output(s)")

    # ── dead-man timer: a phone that goes quiet must not leave the DAW bent ──────
    class FakeMidi:
        def __init__(self): self.sent = []
        def send_pitch_bend(self, ch, val): self.sent.append((ch, val))
        def send_cc(self, *a): pass

    midi = FakeMidi()
    h = server.SensorHandler(eng, midi, pb_idle_sec=0.5)
    h.note_pb(0, 9421, now=100.0)                       # phone sends a bent value at t=100
    check("bridge: a talking phone is not touched",
          h.pb_needing_centre(now=100.4) == [], f"{h.pb_needing_centre(now=100.4)}")
    due = h.pb_needing_centre(now=100.6)
    check("bridge: silence past the idle window is centred", due == [0], f"due={due}")
    h.centre_pb(due)
    check("bridge: centring sends exactly PB 8192", midi.sent == [(0, 8192)], f"{midi.sent}")
    check("bridge: an already centred channel is never re-sent",
          h.pb_needing_centre(now=200.0) == [] and len(midi.sent) == 1, f"{midi.sent}")
    h.note_pb(3, 7000, now=300.0)
    h.note_pb(4, 9000, now=300.0)
    midi.sent.clear()
    centred = h.centre_pb()                              # disconnect path
    check("bridge: disconnect centres every bent channel",
          sorted(centred) == [3, 4] and len(midi.sent) == 2, f"centred={centred}, sent={midi.sent}")
    off = server.SensorHandler(eng, FakeMidi(), pb_idle_sec=0)
    off.note_pb(0, 9421, now=0.0)
    check("bridge: pb_idle_sec=0 disables the watchdog", off.pb_needing_centre(now=9999.0) == [],
          "explicitly disabled = the previous behaviour")

    # ── the restored Mode C: gravity-removed acc.x → pitch bend ─────────────────
    # This is the committed Mode C that worked; the only change is that the phone now
    # declares kind:"pb" explicitly (ADR 0003) instead of relying on the legacy sniff of
    # sensor=="accelerometer" && axis=="x".
    MODE_C = {
        "preset_name": "mode-c", "mappings": [{
            "source": {"type": "sensor", "sensor": "accelerometer", "axis": "x"},
            "target": {"type": "pb", "cc": None, "channel": 0},
            "range": {"in_min": -40.0, "in_max": 40.0, "out_min": 0, "out_max": 127,
                      "dead_zone": 0.02},
            "curve": {"type": "linear", "params": {}},
            "smoothing": {"type": "ema", "alpha": 0.15},
        }],
    }
    fd2, path2 = tempfile.mkstemp(suffix=".json"); os.close(fd2)
    with open(path2, "w", encoding="utf-8") as f:
        json.dump(MODE_C, f)
    try:
        c = server.MappingEngine(path2)

        def pb(v, engine=None):
            """One value in, one pitch-bend count out (the Bridge dedupes repeats, so every
            call here must be its own engine step)."""
            e = engine or c
            out = e.process("accelerometer", "x", v, kind_override="pb")
            return server.pb_from_norm(out[0][4]) if out else None

        rest = pb(0.0)
        check("mode C: rest is exactly centred", rest == 8192, f"0 m/s2 -> {rest}")
        c.reset(); up = pb(10.0)          # reset clears the ema, so this is the raw mapping
        c.reset(); down = pb(-10.0)
        check("mode C: +-10 m/s2 is +-12.5% of the bend",
              (up - 8192, 8192 - down) == (2048, 2048),
              f"+10 -> +{up - 8192} counts, -10 -> -{8192 - down} counts "
              f"(+-2 semitones => +-50 cents at +-40 m/s2)")
        # The Bridge's own dead zone (+-2% of range = +-0.8 m/s2) is what keeps tremor quiet.
        c.reset(); tremor = pb(0.4)
        check("mode C: tremor inside the dead zone stays centred", tremor == 8192,
              f"0.4 m/s2 -> {tremor} (dead zone is +-0.8 m/s2)")
        c.reset(); pb(0.0); stepped = pb(10.0)
        check("mode C: the ema costs about one sample", 8192 < stepped < 8192 + 2048,
              f"first step to 10 m/s2 reports {stepped - 8192} of the eventual 2048 counts "
              f"(alpha 0.15 keeps 15% of the old value)")
        c.reset(); steps = [pb(v) for v in (0, 1, 2, 3, 4, 5)]
        check("mode C: motion is followed monotonically",
              steps == sorted(steps) and len(set(steps)) == 6 and None not in steps,
              f"0->5 m/s2 gives {[s - 8192 for s in steps]} counts")
        c.reset(); pb(0.0); quiet = c.process("accelerometer", "x", 0.7, kind_override="pb")
        check("mode C: resting noise sends nothing", quiet == [], f"0.7 m/s2 -> {quiet}")
    finally:
        os.unlink(path2)
finally:
    os.unlink(path)

print(f"\n{21 - len(fails)}/21 checks passed")
sys.exit(1 if fails else 0)
