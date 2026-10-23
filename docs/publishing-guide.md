# Publishing guide

> **Read this first.** This guide is for reference only. The project ships **no upload code**, and nothing here is guaranteed to work. We **do not recommend** automated publishing: platforms detect and penalize scripted uploads (limited reach, "suspected automated posting" warnings, bans), and their pages and rules change without notice. If you automate uploads anyway, you are responsible for your accounts and for following each platform's terms.

The pipeline ends with `runs/<run>/package/`. The simplest and safest workflow is to upload that kit by hand in each platform's creator app or website. A 2-minute upload per platform is usually worth it.

The rest of this page records what we learned while running uploads to several Chinese platforms, so you can avoid the same traps.

## What is in the kit

- `video.mp4`: 1080×1920, H.264/AAC, loudness about −16 LUFS
- `cover-portrait.jpg` (3:4) for Douyin, Kuaishou, Xiaohongshu and WeChat Channels profile grids
- `cover-landscape.jpg` (16:9) for Bilibili. Bilibili's feeds show a landscape cover even for vertical videos; keep key text in the middle 4:3 area
- `metadata.txt` with:
  - the title, plus a shortened title per platform: Bilibili 80 chars, Douyin / Kuaishou / Channels 30, Xiaohongshu 20 without the 【sign】
  - tags
  - chapters as `mm:ss  title`
  - the description, ending with an AI-assistance statement

## General lessons

1. **"Success" from a tool is not proof.** Platforms silently ignore fields they don't recognize. A confirmation toast only shows how the page looks at that moment. After every upload, check what the platform actually saved (category, AI-content label, cover, title). Do it in the creator dashboard or by reading the post back. Anything you never verified, call "probably set", not "set".
2. **Always rehearse, then check the post list.** If you build a "fill everything but don't click publish" rehearsal mode, check the platform's post list afterwards. A rehearsal once published a test post because the guard compared an escaped button label (`发布`) with the plain text 「发布」. Guard on the visible text of the element actually being clicked.
3. **Some settings lock after publishing.** On Bilibili, the category (分区) and the creation statement (创作声明) cannot be changed after submission. Get them right the first time.
4. **Async steps get overwritten.** Upload pages often process a cover or video in the background. If you change another field before that finishes, the page may save stale data. A cover that looked applied then turned out to be the first video frame. Change one thing, wait until it is really saved, and set the most fragile field (usually the cover) last.
5. **Login checks flicker.** A single "logged out" result is often a network blip (`ERR_CONNECTION_CLOSED`). Check three times a few seconds apart before asking the user to scan a QR code again.
6. **Location fields follow your IP.** With a proxy, WeChat Channels guessed a foreign city as the location. Set "no location" explicitly.
7. **Use the browser people use.** Driving the user's installed Chrome (with a persistent profile) is both more reliable and less suspicious than a freshly downloaded automation browser.
8. **Read the page's own JavaScript before guessing.** Upload pages load their scripts without login. Searching them for field names (`coverKey`, `submit`) shows exactly what the button sends. That takes fewer attempts on the live site, and fewer risky logins.
9. **Upgrading an upload tool can change behaviour.** Keep the previous version. Treat the first real upload after an upgrade as a test and verify every field.

## Bilibili

- **Tool:** [biliup](https://github.com/biliup/biliup) (MIT), a Rust CLI that logs in by QR code and uploads.
- **Use the web submission endpoint.** biliup's CLI defaults to the app endpoint, which drops the newer category field (`human_type2`, e.g. 人工智能 = 1011). Only the web endpoint keeps it. Check the tool's log line to see which endpoint was used.
- **Upload lock folder.** Newer biliup versions create an account lock under `%LOCALAPPDATA%\biliup\locks` before uploading. On some Windows machines biliup cannot create that folder itself and fails with `os error 5`. Creating the folder beforehand fixes it. No post is created when this fails, so a retry will not duplicate.
- **Chapters and the pinned comment** can only be set after the video passes review. Poll the post status, then set them. Chapter titles have length limits, and very short segments are rejected.
- **Collections (合集)** cannot be created through the CLI. Create them once on the website; adding posts to an existing collection works after review.
- There is no official upload API documentation. When fields change, compare with what the creator website itself sends.

## Douyin, Kuaishou, Xiaohongshu, WeChat Channels

- **Tool:** [social-auto-upload](https://github.com/dreammis/social-auto-upload) (MIT), Playwright scripts per platform. Keep your fixes in your own wrapper so updates don't wipe them out.
- **AI-content declaration:** every platform has a checkbox or label for AI-generated content. Make the upload fail if it cannot be ticked rather than publish without it.
- **Douyin:** set the 3:4 cover only. Chapters are supported on the upload page. The description should not repeat the title.
- **Kuaishou:**
  - There is no title field, so the title goes at the start of the description.
  - A "continue editing your last draft?" dialog can hide the upload button; discard the draft.
  - The cover dialog needs real waiting for the image to upload before confirming.
- **Xiaohongshu:** 20-character titles. In our experience, frequent automated posting quickly triggered a **"suspected script publishing" warning**, so we stopped automating it. Treat that as a strong signal.
- **WeChat Channels:**
  - The "short title" accepts only 6–16 characters of letters, digits and a few symbols. Decimal points get stripped (M3.1 → M31), so rewrite them first.
  - Its post list is inside an embedded frame that is hard to read automatically. Check new posts by hand in the 视频号助手 app.
- **Covers by aspect ratio:** profile grids crop 16:9 covers badly. Upload the 3:4 cover wherever the platform allows.

## If you build automation anyway

- Separate **rehearsal** from **real publishing** with a guard that cannot be bypassed by an earlier state, e.g. "Bilibili already done, so publish the others for real".
- After every upload, **read back** the saved settings and alert yourself on any mismatch.
- Keep login cookies out of git and out of logs. Never print tokens or passwords in error messages.
- Publish at a human pace and stop as soon as a platform warns you.
