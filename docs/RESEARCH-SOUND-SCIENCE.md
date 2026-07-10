> Output of a fan-out web-research workflow with **adversarial verification of every high-stakes
> (medical/safety) claim** (86 findings; 28 high-stakes claims fetched-and-verified
> against primary sources). Peer-reviewed evidence is kept separate from adult-extrapolation and from
> marketing; every safety number traces to a verified citation. AI-generated — sanity-check any number
> against the cited source before it drives user-facing medical/safety copy.

# Best-in-Class Procedural Ambient Audio for Infant Sleep — Evidence + Synthesis Recipes

*Research report for Lull. Two audiences: (A) what the evidence says about the best sounds for baby sleep/calm and how to deliver them safely; (B) zero-dependency JS synthesis recipes to make `pipeline/bake.js` sound best-in-class. Every safety number is held to its verified value; peer-reviewed evidence is kept separate from adult-extrapolation and from marketing.*

---

## 1. Evidence verdict — what actually helps a baby sleep

**Bottom line: steady broadband noise demonstrably *settles* newborns faster in the short term; it is NOT proven to give longer or deeper sleep; and no noise *color* has ever won a head-to-head infant trial. Womb/heartbeat sounds are best justified for the 0–3 month window, and mostly by analogy from procedural-pain research, not home-sleep RCTs.**

### 1a. The one direct infant RCT (the load-bearing citation)
- **Spencer JA, Moran DJ, Lee A, Talbert D. "White noise and sleep induction." *Arch Dis Child* 1990;65(1):135–137 (PMID 2405784, doi:10.1136/adc.65.1.135).** Randomized, two groups of 20 neonates aged 2–7 days (n=40). **16/20 (80%) fell asleep within 5 minutes with white noise vs 5/20 (25%) spontaneously in controls.** Authors' conclusion: "white noise may help mothers settle difficult babies."
- **How to state it honestly:** *"In one small randomized trial, white noise settled significantly more newborns to sleep within 5 minutes than no sound (80% vs 25%)."* Do **not** write "reliably" or "sleeps longer." The endpoint is **short-term settling / sleep onset only** — nothing about sleep duration, architecture, or safety. The paper reports **no dB level or spectrum**, so it carries zero hearing-safety information, and it did not compare continuous vs intermittent playback (do not cite it to justify all-night continuous play).

### 1b. The tempering review (why we must not oversell)
- **Riedy SM, Smith MG, Rocha S, Basner M. "Noise as a sleep aid: A systematic review." *Sleep Medicine Reviews* 2021;55:101385.** 38 articles; by **GRADE the quality of evidence that continuous noise improves sleep is VERY LOW** ("which contradicts its widespread use"). Narrative review (not meta-analysis) because studies were too heterogeneous to pool; results ranged from improved to *disrupted* sleep. Authors warn continuous noise "may also negatively affect sleep and hearing." **Caveat: this is an adult-inclusive review**, so it is adult-extrapolated for nursery use — cite it for the *mechanism* and for skepticism, never as proof noise works.

### 1c. Noise color (white vs pink vs brown) — essentially marketing for infants
- **No published infant study compares colors head-to-head.** Popular "pink/brown is better for sleep" claims come from adult work or have no clinical support.
- The pink slow-wave-sleep results are **adult-only and non-transferable**: **Papalambros et al. 2017 (*Front Hum Neurosci* 11:109)**, n=13 adults aged 60–84, used **real-time EEG phase-locked *pulses* of pink noise timed to the slow-oscillation up-state** — not continuous playback. Critically, **whole-night slow-wave activity did NOT differ from sham**; gains were confined to the brief stimulation intervals. A passive looping speaker cannot reproduce this. It provides **zero** support for "continuous pink noise deepens sleep," and none for infants.
- **Zhou et al. 2012 (*J Theor Biol* 306:68–72, PMID 22726808):** continuous pink noise modestly increased "stable sleep time" (~23%) in young *adults*, measured by ECG cardiopulmonary-coupling proxy, not PSG. It compared pink vs *quiet*, **not pink vs white** — so it does not establish pink-over-white superiority. Adult design rationale only.
- **Defensible position:** a pink/brown-tilted spectrum is preferable because it **removes harsh high-frequency energy** (gentler, less fatiguing, and cuts the exact >4 kHz band most implicated in hearing risk) — a *comfort/safety* argument, **not** a proven sleep-efficacy one.

### 1d. Womb / heartbeat / shushing and the age window
- **The audible in-utero rhythm is the MATERNAL heartbeat (~60–80 bpm resting) and the blood-flow whoosh, not the faster fetal heart (110–160 bpm).** The uterus is a low-pass filter (see §3).
- **Heartbeat-specifically-beats-plain-noise is weak:** Salk's classic 1960s finding (~72 bpm heartbeat → less crying, +40 g weight) **did not replicate** (Tulloch et al. and other 2–4-day newborn studies found no pacifying effect). Offer heartbeat as a *preference* preset; do not claim superiority over plain low noise.
- **Real RCT support exists but only for procedural pain/physiology, not home sleep:** maternal heart sound (Salmani et al., *J Neonatal Nursing* 2021, n=60) significantly reduced NIPS pain and stabilized HR/O₂/resp during blood sampling; a 2024 white-noise meta-analysis (Zhang, *Nursing Open*, 8 RCTs) found pain SMD −1.58, HR −7.04 bpm — **but with extreme heterogeneity (I²=91–98%) and low study quality**. "Reduces crying" is **under-evidenced** (the flagship heart-sound RCT measured pain, not crying). These legitimize womb/heartbeat presets by analogy; they are **not** home-sleep evidence.
- **Age window (theory-tier, per Karp, not RCT):** the "fourth trimester" = first ~3 months; the calming reflex is said to "fade around 3–4 months" (aligns with the real 4-month sleep regression). After that Karp himself attributes continued benefit to **conditioning/habit**, not the reflex. **Product implication:** womb/heartbeat presets are most defensible as a **newborn (0–3 mo) feature**; for older infants a steady pink/brown noise is equally justified.

### 1e. Contested harms (plausible, not established — keep separate from hearing loss)
- **Animal signal is the strongest:** Chang & Merzenich, *Science* 2003;300:498–502 — continuous moderate (non-injurious) noise *delayed auditory-cortex maturation* in rat pups (24 h continuous, doesn't map cleanly to intermittent human use).
- **Human scoping review:** **De Jong RW et al. "Continuous white noise exposure during sleep and childhood development." *Sleep Medicine* 2024;119:339–347 (PMID 38663282)** — 20 studies (7 animal, 13 human; combined n≈9,511, of which 9,428 humans). Human data *generally corroborated* the animal harm signal for continuous moderate-intensity noise; some machines hit 91 dB at max; **low-intensity noise during sleep may be beneficial. Conclusion: limit maximal intensity AND duration.** (Note: often mis-cited as "Riddle et al." — first author is De Jong.)
- **Also flag:** "raising the arousal threshold" is a double-edged mechanism — reduced arousability is itself a SIDS risk marker — which is exactly why continuous loud all-night broadband is not unambiguously benign.

---

## 2. Safety & recommended defaults

**All numeric safety anchors trace to one peer-reviewed study plus standards bodies. Hold them exactly.**

### 2a. The verified numbers
- **Hugh SC, Wolter NE, Propst EJ, Gordon KA, Cushing SL, Papsin BC. "Infant Sleep Machines and Hazardous Sound Pressure Levels." *Pediatrics* 2014;133(4):677–681 (doi:10.1542/peds.2013-3617, PMID 24590753).** 14 infant sleep machines, **max volume**, measured at 30/100/200 cm with a 6-month-old ear-canal correction. **Mean output 79 dBA @ 30 cm, 71 dBA @ 100 cm, 63 dBA @ 200 cm.** **All 14 exceeded 50 dBA at 30 cm; all 14 at 100 cm; 13/14 (all but one) still exceeded 50 dBA at 200 cm. 3/14 exceeded 85 dBA at 30 cm.**
- **50 dBA** = the recommended noise limit for infants in **hospital nurseries** (Sound Study Group; Philbin/Robertson/Hall, ***J Perinatol*** 1999;19(8):559–563, PMID 10645519 — exact criteria: hourly **Leq 50 dB, L10 55 dB, Lmax 70 dB**, A-weighted). A **sleep/vital-sign/speech** standard, **not** a hearing-protection threshold. AAP 1997 (Committee on Environmental Health, *Pediatrics* 100:724–727), following EPA 1974, targets ~**45 dBA** in the NICU. These are **construction/hospital standards, not validated home limits.**
- **85 dBA/8 h** = **NIOSH REL** (85 dBA 8-h TWA, **3 dB exchange rate** → 88 dBA=4 h, 91 dBA=2 h), more protective than OSHA's 90 dBA/5 dB PEL. An **adult occupational** standard **extrapolated** to infants — a hard ceiling never to be approached, not a target.
- **AAP's own guidance is purely qualitative** (verbatim): *"locate them as far away as possible from the infant, set the volume as low as possible and limit duration of use."* **AAP publishes no dB, distance, or timer number.** The "7 ft" figure is a lay reading of the study's 200 cm measurement point (note 2 m = 6.56 ft, not 7 ft) — a heuristic, **not** AAP-verbatim, and **distance alone is insufficient** (13/14 machines still exceeded 50 dBA at 2 m at max volume).
- **WHO context:** Community Noise Guidelines 1999 — bedroom **≤30 dB LAeq** continuous / **≤45 dB LAmax** single event for good sleep; Night Noise Guidelines 2009 — **Lnight,outside 40 dB** (interim 55). Adult/environmental limits on *unwanted* noise — supportive, not infant-specific.
- **Karp/SNOO conflict (marketing):** advises briefly raising white noise to ~**85 dB** (a hard cap SNOO "never exceeds," "only a few minutes") to break through active crying, then dropping to ~**65 dB**. This **collides with the 50 dBA sustained-nursery limit** — never present 80–85 dB as a safe standing volume.

### 2b. Concrete recommended defaults for Lull
| Setting | Recommendation | Basis |
|---|---|---|
| **Default sound** | **Pink noise** (broad masking + gentle tilt), with **Womb** surfaced for 0–3 mo, **Brown/Fan** for a warmer low option | Spencer settles on broadband; pink covers speech band (§3) yet less harsh than white; womb defensible only for newborns |
| **Default volume** | **GAIN_DEFAULT 0.3** — keep the low default. Slider cap raised to **1.0 (100%)** by product choice; the conservative lever is the default + guidance, not the ceiling. | See below — the *default* is conservative on the *digital* side; the app can't enforce a dBA ceiling regardless of the cap |
| **Sleep timer** | Default **ON**, ~**30–45 min fade-out**, not continuous all-night | Hugh: "short duration… until the infant is sleeping"; the 85 dBA/8 h risk is *level × duration* compounding |
| **Placement copy** | *"Place the phone across the room (≥2 m), never in or on the crib. Distance alone is not enough — keep the volume low."* | Hugh verbatim recommendation; 2 m insufficient by itself |
| **Low-volume warning** | Show a **calibration note + optional phone-SPL-meter prompt**: "Aim for ≤50 dBA at the crib. This app cannot measure real loudness — it depends on your device and volume." | AAP: app cannot guarantee dBA; measure at the listening position |

### 2c. Is the default (GAIN_DEFAULT 0.3) conservative enough?
**Yes, on the digital side — but honestly qualify it.** 0.3 gain is ~−10.5 dBFS of trim below the baked file. That is genuinely conservative *within the signal chain*. **But digital gain does not equal acoustic dBA** — real SPL depends on the phone's hardware volume, speaker, and distance. **The slider cap was raised to 1.0 (100%) by product choice**, so the safety mechanism is the low *default* plus the distance/volume/meter guidance, NOT the ceiling — the app cannot enforce a dBA ceiling regardless. Do not claim "safe" from the gain value alone.

---

## 3. Spectral target

**A calming nursery sound should be steady, broadband where it needs to mask, and tilted DOWN so harsh highs are suppressed.**

Recommended long-term-average-spectrum (LTAS) targets, verifiable by FFT of the baked WAV:
- **BALANCED (default):** ~**−3 dB/octave** (pink, 1/f) from ~40 Hz to ~6 kHz, then steep roll-off (**−12 dB/oct above ~6 kHz**). Equal energy per octave matches logarithmic cochlear/Bark processing → reads "natural," not hissy.
- **DEEP / WOMB:** flat/low-shelf below ~300–500 Hz, **−6 dB/oct** knee near **~500 Hz**, steep above so **little energy remains above ~2 kHz** (matches the measured uterine low-pass, §below).
- **High-pass everything below ~20–30 Hz** to stop inaudible sub-bass eating headroom.
- **Masking constraint:** speech (siblings, TV) lives ~300–3000 Hz, intelligibility ~1000–5000 Hz. A pure brown/womb sound will **not** mask speech; **pink is the best single compromise** — keep at least one preset with real 300–4000 Hz energy.
- **Steadiness:** keep short-term RMS variation small (~2–3 dB) for the masking/"deep sleep" presets (our own engineering heuristic, not a literature threshold). Transients in the masker itself can startle.

**Measured womb spectrum (real, not marketing):** intrauterine SPL ~70–90 dB dominated by **<100 Hz**; energy above ~500 Hz falls toward ~40 dB; the maternal abdomen attenuates ~**30 dB above 600–1000 Hz** (Benzaquen, *Obstet Gynecol* 1990, PMID 1635729; Querleu et al., *Eur J Obstet Gynecol* 1988, PMID 2386134; Parga et al., *PLoS ONE* 2018, PMC5944959). Womb = **brown noise steeply low-passed (corner ~400–600 Hz, ≥24 dB/oct)**.

**How our current sounds score:**
| Sound | Current spectrum | Verdict |
|---|---|---|
| `pink` (Kellet) | accurate ±0.05 dB −3 dB/oct | **On target — keep** |
| `brown` (leaky integrator g=0.02) | −6 dB/oct | **On target — keep**; add HPF <20 Hz |
| `womb` (pink ×0.9 LP) | muffled but knee too high/soft; heartbeat present | **Retune** — steepen LP to knee ~500 Hz, base on **brown** not pink |
| `fan` (brown LP 0.93/0.07) | good low bed | **Good bed, no periodic content** (§4) |
| `rain` (HP 0.72 + mild LP) | bright/hissy top | **Retune** — add ~6 kHz roll-off softer variant; fix droplets (§4) |
| `fire` (brown LP + spike) | rumble-heavy, no hiss | **Retune** — missing hiss + real crackle (§4) |
| `wind` (2× one-pole LP sweep) | filtered hiss, **no resonant peak** | **Retune** — needs band-pass resonance (§4) |
| `ocean` (single cos swell) | periodic/mechanical | **Retune** — multi-LFO + crest layer (§4) |
| `white` | flat, +3 dB/oct hotter per octave | **Keep but de-prioritize**; optionally offer a low-passed variant |
| `heartbeat` | 58 Hz sine + lub-dub | **OK**; label "maternal ~60 bpm" |

---

## 4. Best-in-class synthesis recipes (the meat)

**Governing principle (Farnell, *Designing Sound*, MIT Press 2010 — the authoritative zero-dep, first-principles reference): decompose each ambience into BED + TRANSIENTS + HISS, each an independently slow-modulated layer, then sum.** The single biggest realism lever is **independent per-band modulation**, not a fancier single filter. All of this is plain-JS biquads + one-poles + RNG in the existing per-sample loop.

### Shared primitives to add to bake.js (the real gap)
1. **RBJ biquad band-pass** (resonant, has a peak — one-poles do not). This unlocks wind, rain plinks, fire crackle, fan blade tone.
2. **Poisson event scheduler** — `dt = -Math.log(random())/rate` for exact events/sec; wrap phase modulo `loopN` for seam-safety. (Our current `Math.random()<p` Bernoulli is ~equivalent at low rates but gives no clean rate parameter and, more importantly, fires **single-sample spikes** = broadband clicks.)
3. **Enveloped grain / modal resonator**: each event is a short exp-decay × band-passed noise burst (or a 2-pole resonator `y[n]=2R·cosθ·y[n-1] − R²·y[n-2] + gain·x[n]`, `R=exp(−6.9078/(T60·SR))`), **not** a lone spike.
4. **Band-limited LFO** (white → one-pole ~0.1–2 Hz) for gusts/breathing.

### Per-texture recipes

**PINK / BROWN — keep, minor polish.** Pink (Kellet accurate variant) is already instrumentation-grade; keep it. Brown leaky integrator is correct; **add a high-pass below ~20–30 Hz** to stop DC/sub-rumble wasting headroom, and optionally cascade one gentle LP for a "deep" variant.

**RAIN — weak now (single-sample droplet spikes).** Bed: pink/white through HPF ~1–2 kHz + gentle LP ~8–10 kHz (offer a *softer* variant rolled off at ~6 kHz for sleep). **Droplets: Poisson stream (~10–40/s light, up to hundreds for downpour), each a resonant band-pass "ping"** (biquad BP, center 1–5 kHz, Q≈5–30, exp-decay 20–80 ms), center frequency varied per drop. For louder drops add the **van den Doel rising-pitch chirp** (see below). **Replace** the `(random*2−1)*0.5` spike.

**OCEAN — periodic/mechanical now (single cos, 3 cycles).** Use **three incommensurable swell LFOs** (e.g. periods ~9/11/12.5 s; Drake Andersen Max Tutorial #7) modulating both amplitude and a resonant LP cutoff (sweep ~300→800 Hz, resonance 0.3→0.9). **Add a separate crest-wash layer**: brighter white noise LP'd ~4 kHz, gated when the swell exceeds a threshold, **asymmetric envelope (fast attack ~0.2–0.5 s, slow release ~2–4 s)** = the wave breaking. *Loop tension:* incommensurable LFOs don't return to phase 0 at 30 s — either lengthen the loop (60–120 s) or snap periods to whole cycles of `loopN` and rely on the 1 s crossfade.

**WIND — filtered hiss now, no resonance.** Farnell's wind = **several parallel resonant band-passes** on one noise source: e.g. BP 200 Hz Q≈40 (×2), BP 400 Hz Q≈40 (×2), BP 800 Hz Q≈1 (×0.8, airy), plus HP 200. Drive from a shared **~0.1 Hz wind-speed LFO** plus **stochastic gusts** (noise → LP ~3 Hz, thresholded) modulating **both amplitude and center frequency (±~1 octave)**. Optional occasional **swept high-Q "howl"** (BP Q 20–60, center random-walked 1000–2000 Hz) mixed low — keep it rare, it can be alarming in a nursery.

**FIRE — missing hiss + real crackle now.** Three layers (Farnell mix ≈ lapping 0.6 / crackle 0.2 / hiss 0.3):
- **Lapping bed:** noise → **BP ~30 Hz Q≈5** → gain up → HP 25 Hz → **soft-clip (tanh) ±0.9** (harmonic warmth, audible on small speakers).
- **Crackle:** **Poisson pops (~30 ms mean gap)**, each a **~15–25 ms exp-decay × band-passed burst, pitch randomized ~1500–2000 Hz**, amplitude jittered (occasional louder pops/clusters). Replace the single-sample `+0.9` spike.
- **Hiss:** noise → HP ~1 kHz, amplitude-modulated by a slow (~1 Hz) random envelope so it "breathes." (This is what sells "flame" vs "rumble.")

**FAN — good bed, no periodic component now.** Keep the LP brown rumble (motor). **Add a low-level blade-pass tone**: BPF = blades × RPM/60 (nursery fan ~1200 RPM, 3–5 blades → ~60–100 Hz), plus faint integer harmonics and a short feed-forward **comb** (delay = 1/BPF) for blade slap. **Keep blade-rate an integer number of cycles over the loop** for seamlessness.

**WOMB — retune toward the measured spectrum.** Base on **brown** (−6 dB/oct) not pink; cascade a **steep LP, knee ~500 Hz ≥24 dB/oct** so >90% of energy is <500 Hz. Add a **blood-flow whoosh**: slow amplitude + LP-cutoff LFO synced to a **maternal ~60–70 bpm (~1.0–1.17 Hz)** pulse. Keep heartbeat subtle (−12 to −18 dB under the bed). This produces the "consistent, rumbly" quality Karp says hissy fans lack.

**HEARTBEAT — good, minor.** 60 bpm lub-dub is fine; **label it "maternal/resting ~60 bpm," not fetal** (fetal is 110–160 bpm but the *audible* in-utero pulse is maternal). Optionally add a low-frequency (~50–80 Hz) body and keep the crossfade whole-cycle (60 bpm already divides whole-second loops).

**Optional shared bubble engine (rain/stream/ocean-crest from one code path):** van den Doel liquid model — a damped sinusoid with *rising* pitch: `bubble(t)=A·e^(−β₀t)·sin(2π·f₀·(1+ξ·β₀t)·t)`, Minnaert `f₀≈3.26/a_meters` (radius→pitch; 1 mm→3.26 kHz), β₀=π·f₀·δ (δ≈0.043), ξ≈0.1. Poisson-superpose many bubbles, scale amplitude down (~0.23×) as density rises. This is the physically correct primitive for all water.

---

## 5. Loudness & looping

**Move from peak-normalization to LUFS-matched levels; keep and formalize the equal-power loop.**

### The problem
Current `seamlessLoop` **peak-normalizes every texture to AMP=0.6**. Textures have very different crest factors (steady brown/womb ≈ low crest; transient rain/fire ≈ high crest), so peak-matching leaves the **low-crest sounds perceptually LOUDER** — a texture switch can jump loudness and, worse, jump toward the SPL ceiling.

### The fix — implement ITU-R BS.1770 integrated loudness in plain JS
1. **K-weight** each channel: two cascaded biquads (high-shelf ~+4 dB above ~1.5 kHz, then ~80 Hz high-pass). Re-derive coefficients per sample rate (44.1 kHz here).
2. 400 ms gating blocks, 75% overlap; per-block mean-square `z_i`.
3. Block loudness `L = −0.691 + 10·log10(Σ Gᵢ·zᵢ)`, mono G=1.
4. **Absolute gate −70 LKFS**, then **relative gate −10 LU** below the surviving mean; re-average → **integrated LUFS**.
5. Apply one linear gain `g = 10^((L_target − L_measured)/20)`.

### Concrete targets
- **Internal reference: −23 LUFS integrated** for the whole library (EBU R128). The absolute value is arbitrary for a nursery (real SPL = device + distance); the point is **one fixed target so all textures match perceptually**. Keep GAIN_DEFAULT 0.3 as the app trim that maps this reference to a quiet-nursery SPL.
- **True-peak cap: spec −1 dBTP, but budget −1.5 to −2 dBTP** for AAC/MP3 transcode headroom on old iOS. Measure via 4× oversample → max|x| → `20·log10(peak)`.
- **Order of operations:** synthesize → build seamless loop → measure LUFS of the *final looped* buffer → apply gain → **re-measure true-peak**; if over budget, lower that texture's target or soft-clip and re-measure. Never set final gain from peak alone.

### Looping
- **Keep the equal-power (√, i.e. cos/sin) crossfade** for the noise textures — it is correct for *uncorrelated* material (tail/head powers add; midpoint −3 dB each side). Equal-*gain* would cause an audible −3 dB power dip. This is already what bake.js does; formalize it.
- **Choose the law by correlation:** filtered-noise textures → **equal-power**; periodic textures (heartbeat, tonal womb whoosh) → **whole-cycle looping** (fit integer cycles into `loopN`, phase-continuous, no crossfade needed) + a 1–5 ms ramp to kill sample-level discontinuity.
- **Crossfade length ≥ ~10× the period of the lowest significant band.** 1.0 s spans ~100 cycles at 100 Hz — ample; if loops shorten or low-end rises, keep ≥0.2 s.
- **Every new periodic element (gust LFO, blade rate, crackle count, swell) must be a whole number of cycles over `loopN`** — extend the existing `i % loopN` discipline to them.
- Optional micro-optimization: Signalsmith's k=1.4186 polynomial crossfade is ~15× faster than cos/sin with <0.53% RMS error — only worth it for many/long bakes; for one-time 30 s loops exact cos/sin is inaudibly perfect.

---

## 6. Prioritized action list for bake.js

**Recommended default nursery sound: Pink noise** (broadband settling per Spencer; masks the speech band; less harsh than white). Surface **Womb** prominently for 0–3 months. **Recommended default volume: keep the low GAIN_DEFAULT 0.3** (the slider cap is 1.0 / 100% by product choice), paired with distance + duration + meter guidance.

Highest-impact first — each a small, specific coding task:

1. **[Safety/loudness — highest impact] Replace peak-normalization with ITU-R BS.1770 integrated-loudness normalization to −23 LUFS**, measured on the final looped buffer, with a −1.5 dBTP true-peak re-check (4× oversample). *Why first: fixes perceptual-level mismatch between textures AND keeps every option inside a predictable SPL envelope.* (§5)
2. **[Safety — product, not bake] Add a 30–45 min fade-out sleep timer (default ON) + distance/volume/meter UI copy** ("place ≥2 m across the room, never in/on the crib; aim ≤50 dBA; app can't measure real loudness"). (§2)
3. **[Primitives] Add three reusable functions: RBJ biquad band-pass, a Poisson event scheduler (exp-gap, loop-wrapped), and an enveloped/modal grain.** Everything below depends on these. (§4)
4. **[Fire] Rebuild as 3 layers: BP~30 Hz + soft-clip lapping bed, Poisson band-passed exp-decay crackle grains (1.5–2 kHz, ~15–25 ms), and an HP ~1 kHz breathing hiss.** Biggest single realism win; current fire is missing hiss and real crackle. (§4)
5. **[Wind] Replace the two one-pole LP sweep with parallel resonant band-passes (200/400/800 Hz, Q 40/40/1) driven by a ~0.1 Hz wind-speed LFO + stochastic gusts.** One-poles have no resonant peak, so current wind reads as hiss. (§4)
6. **[Rain] Replace single-sample droplet spikes with Poisson resonant band-pass "plinks" (1–5 kHz, Q 5–30, 20–80 ms decay), varied per drop; add a softer ~6 kHz-rolled variant.** (§4)
7. **[Womb — retune] Rebase on brown, steepen LP to ~500 Hz knee (≥24 dB/oct), add a ~60–70 bpm blood-flow whoosh; keep heartbeat −12 to −18 dB under the bed.** Match the measured uterine spectrum. (§3, §4)
8. **[Ocean] Move to three incommensurable swell LFOs + an asymmetric-envelope crest-wash layer** (resolve the loop-alignment tension by lengthening the buffer or snapping to whole cycles). (§4)
9. **[Fan] Add a low-level blade-pass tone (BPF = blades×RPM/60 ≈ 60–100 Hz) + comb**, integer cycles over the loop. (§4)
10. **[Verification] Add an FFT-based bake-time assertion that each texture's LTAS slope is within ±1 dB/oct of its target** (pink −3, brown/womb −6), and that womb has negligible energy >2 kHz. (§3)
11. **[Housekeeping] High-pass all noise below ~20–30 Hz; label heartbeat "maternal ~60 bpm"; keep white but de-prioritize (optionally offer a low-passed white).** (§3)

**Files:** synthesis + normalization live in `/Users/lifeart/Repos/mesh-playback/pipeline/bake.js` (generators lines ~30–170, `seamlessLoop` ~172–192 is where LUFS replaces peak-normalize). Manifest at `/Users/lifeart/Repos/mesh-playback/web/player/assets/manifest.json`. Safety/timer copy belongs in the player UI, not the baker.

---

### Evidence tiering summary (state honestly in any user-facing copy)
- **Infant-evidenced (peer-reviewed):** short-term settling from broadband noise (Spencer 1990, n=40); SPL hazard of sleep machines (Hugh 2014); developmental caution from continuous moderate noise (De Jong 2024 scoping; Chang & Merzenich 2003 animal).
- **Adult-extrapolated:** pink-noise sleep effects (Papalambros 2017 phase-locked; Zhou 2012); NIOSH 85 dBA/8 h; WHO bedroom limits; "noise as sleep aid" is GRADE very-low (Riedy 2021).
- **Theory/marketing:** the "calming reflex," the 3–4-month window, noise-color superiority, and the 80–85 dB "louder to soothe" tactic (Karp/SNOO) — never present as evidence, and never present 80–85 dB as a safe standing volume.
