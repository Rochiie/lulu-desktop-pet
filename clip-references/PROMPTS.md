# Prompts for new Lulu tricks

Each new clip must join seamlessly with the ones Lulu already has. The surest way
is to give the video generator a **first frame** and a **last frame** image from
this folder:

| File | Use |
|---|---|
| `stand_facing_right_on_green.png` | Standing pose (start and end of most tricks) |
| `stand_facing_left_on_green.png` | Standing pose mirrored: the **last frame of the turn** |
| `sleep_pose_on_green.png` | Sleeping pose |
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

**12. Run (three clips)**
Running needs a start, a repeating loop and a stop, like her walk:
- `run_start` (about 1 second). First frame: `stand_facing_right_on_green.png`.
  > The dog breaks from standing into a happy gallop, running in place (the camera tracks it, so
  > it stays in the middle of the frame).
- `run_loop` (about half a second). One full gallop stride that **loops seamlessly**: the last
  frame flows straight into the first.
  > The dog gallops in place, one full stride.
- `run_stop` (about 1.5 seconds). Last frame: `stand_facing_right_on_green.png`.
  > The dog slows from a gallop to a stop and stands still.

## Turning a video into a Lulu clip

From the project folder (needs ffmpeg: `winget install Gyan.FFmpeg`):

```
npm run make-clip -- "C:\path\to\video.mp4" clip_name
npm run make-clip -- "C:\path\to\turn.mp4" turn --ends-facing left
```

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
