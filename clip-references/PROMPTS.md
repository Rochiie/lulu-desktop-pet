# Prompts for new Lulu tricks

Each new clip must join seamlessly with the ones Lulu already has. The surest way
is to give the video generator a **first frame** and a **last frame** image from
this folder:

| File | Use |
|---|---|
| `stand_facing_right_on_green.png` | Standing pose (start and end of most tricks) |
| `stand_facing_left_on_green.png` | Standing pose mirrored: the **last frame of the turn** |
| `sleep_pose_on_green.png` | Sleeping pose |
| `pickup_frame_on_green.png` | Standing pose, smaller, with room above her: **first and last frame of the pick-up** |
| `*_facing_*.png` / `sleep_pose.png` (no "green") | The same poses with a transparent background |

Use the `_on_green` versions if your tool doesn't accept transparent images.

## Base prompt (put this before every trick)

> A black and tan miniature dachshund with a smooth, glossy short coat: black body, tan eyebrows,
> tan muzzle, tan chest and tan paws, long soft floppy ears. Seen in exact side profile, full
> body in frame, standing on a flat floor at the bottom of the frame, on a solid flat chroma-green
> background (#00B140). Locked-off static camera at the dog's eye level: no camera movement, no
> zoom, no cuts. Even, soft studio lighting with no shadows on the background. No props, no
> people, no text. The dog stays in the same place in the frame and its feet stay on the same
> floor line. Natural, realistic dog movement. Match the first and last frame images exactly.

## The tricks

**1. Turn around on the spot** (`turn`, about 1 second)
First frame: `stand_facing_right_on_green.png`. Last frame: `stand_facing_left_on_green.png`.
> The dog turns around on the spot to face the other way. It shifts its weight back, steps its
> front paws round while its back end swings round behind it, its head and chest briefly face the
> camera at the halfway point, and it finishes standing still in exact side profile facing left.

**2. Roll over for a belly rub** (`roll_over`, about 5 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog lies down, rolls onto its back with all four paws in the air, wiggles happily from side
> to side for a moment, then rolls back over and stands up, ending in the same pose it started in.

**3. Beg / sit pretty** (`beg`, about 5 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog sits, then sits up on its hind legs with its front paws tucked against its chest, looking
> up hopefully. It holds the pose for about two seconds, drops back down and stands up again.

**4. Shake off** (`shake`, about 2.5 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog does a full-body shake, like after a bath, starting at its head (ears flapping) and
> rippling down to its tail, then stands still again.

**5. Yawn** (`yawn`, about 3 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog gives a big, sleepy yawn: mouth wide open, tongue curling, eyes squinting. Then it closes
> its mouth and stands still again.

**6. Spin before lying down** (`spin`, about 2 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog turns one full circle on the spot, the way dogs do before settling down, and ends
> standing in exact side profile facing right, as it started.

**7. Scratch an ear** (`scratch`, about 5 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog sits, scratches behind its ear with a hind leg for about two seconds, then stands up
> again.

**8. Head tilt** (`head_tilt`, about 3 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog turns its head towards the camera and tilts it curiously to one side, then the other,
> ears shifting, then turns its head back to profile.

**9. Give paw** (`paw`, about 5 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog sits, lifts one front paw forwards as if offering a handshake, holds it for a second,
> puts it down and stands up again.

**10. Play with a ball** (`play`, about 4 seconds)
First and last frame: `stand_facing_right_on_green.png`. Don't show a ball (Lulu draws one).
> The dog play-bows, then nudges at the floor just in front of its nose twice, playfully, as if
> pushing a toy, wagging its tail, then stands still again.

**11. Bark** (`bark`, about 3 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog barks two or three times, with a small bounce of its front legs on each bark, then
> stands still again.

**12. Zoomies (two videos)** (`run_start`, `run_stop`)
The camera follows her, so she gallops "on the spot" in the middle of the frame; Lulu
moves her across your screen. Keep the background plain green with no floor texture.
- `run_start` (5 seconds). First frame: `stand_facing_right_on_green.png`. No last frame.
  > The dog suddenly bursts from standing into an excited, fast gallop to the right, ears
  > flying, and keeps galloping steadily for the rest of the clip. The camera tracks
  > alongside so the dog stays in the middle of the frame, in side profile.
- `run_stop` (5 seconds). Last frame: `stand_facing_right_on_green.png`. No first frame.
  > The dog is galloping fast to the right, then slows to a trot, then a walk, and stops,
  > standing still in side profile, panting happily. The camera tracks alongside so the dog
  > stays in the middle of the frame.

I cut one seamless gallop stride out of these to make the repeating loop.

**13. Dig** (`dig`, about 4 seconds)
First and last frame: `stand_facing_right_on_green.png`.
> The dog puts its nose down and digs eagerly at the floor in front of it with both front
> paws, quick alternating scrapes, then stops, lifts its head and stands still again. No
> dirt, no hole, no particles: the floor stays clean and flat.

**14. Breathing while standing** (`stand_idle`, 5 seconds)
First and last frame: `stand_facing_right_on_green.png`. She plays this between
actions instead of freezing, so keep every movement small.
> The dog stands still and relaxed in the same spot, breathing calmly: its chest and belly
> gently rise and fall, it blinks slowly, one ear twitches once, its nose sniffs the air once,
> and its tail sways slowly. Its feet never move and its head stays in side profile. It ends
> exactly as it started.

Optional second one for variety (`stand_idle2`, 5 seconds), same frames:
> The dog stands relaxed in the same spot, breathing calmly. It shifts its weight very slightly,
> glances up and a little towards the camera, licks its lips once, then looks straight ahead
> again in side profile. Its feet never move. It ends exactly as it started.

**15. Picked up** (`pickup`, 10 seconds)
First and last frame: `pickup_frame_on_green.png` (not the usual one: this one leaves
room above her). Don't use the base prompt for this one; use this whole prompt:
> A black and tan miniature dachshund with a smooth, glossy short coat: black body, tan
> eyebrows, tan muzzle, tan chest and tan paws, long soft floppy ears, seen in exact side
> profile on a solid flat chroma-green background (#00B140). Locked-off static camera: no
> camera movement, no zoom, no cuts. Even, soft studio lighting, no shadows. No people, no
> hands, no props, no text.
> The dog is gently lifted straight up off the floor, as if scooped up by invisible hands under
> its chest and belly. Its body stays level and supported the whole time, and it rises about one
> head-height. Its legs hang down loosely and relaxed. It stays up in the air for about five
> seconds, happily wagging its tail, ears swaying, paws paddling gently in the air now and then,
> glancing towards the camera. Then it is gently lowered straight back down until all four paws
> touch the floor, and it stands still in exact side profile facing right, as it started.

Negative prompt (if your tool has one): `hands, arms, person, harness, leash, collar, shadow,
camera movement, zoom, cut, text, watermark`.

I cut this into three clips: being lifted, a seamless dangling loop (she stays in it for as long
as you hold her), and being put back down.

## Turning a video into a Lulu clip

From the project folder (needs ffmpeg: `winget install Gyan.FFmpeg`):

```
npm run make-clip -- "C:\path\to\video.mp4" clip_name
npm run make-clip -- "C:\path\to\turn.mp4" turn --ends-facing left
```

For a run (two videos filmed with the camera tracking her):

```
npm run make-clip -- --run "C:\path\to\run-start.mp4" "C:\path\to\run-stop.mp4" run
```

This writes `run_start`, `run_loop` and `run_stop`, and prints their manifest
entries and root motion (paste the root motion into `src/renderer/root-motion.js`).

For the pick-up video:

```
npm run make-clip -- "C:\path\to\pickup.mp4" pickup --pickup --no-zoom
```

This keeps her height off the floor (scaled down if her ears would leave the
clip), writes `pickup_lift`, `pickup_held` (a loop) and `pickup_down`, and the
`held` pose picture `pickup_held_first.png`.

It removes the green background and the watermark, lines her up with her
standing pose, undoes any camera zoom, trims the still frames, blends the ends
into her exact poses, writes `assets/clip_name.webm`, and prints the manifest
entry to add. It refuses a video whose first or last frame is too different
from her standing pose to join seamlessly.

## Tips

- If your tool can only take a first frame, make the clip a bit longer than needed. I can find
  the moment where she returns closest to the standing pose and trim there.
- Any size or aspect ratio is fine (e.g. 16:9). I'll convert each clip to Lulu's format
  (532 × 312, 24 fps, transparent background), line it up with the reference frame, check the
  first and last frames match her poses, measure her foot movement, and wire it into her
  behaviour.
- For a walking U-turn (turning round mid-walk instead of stopping first), I can extract
  mid-stride reference frames from her walk clip when you want to try it.
