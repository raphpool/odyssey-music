# 2026-05-19 Stream Bridge

The stream endpoint fetches audio through a local yt-dlp bridge reached by deployment-specific networking. The server caches downloaded m4a files and serves them with HTTP Range support so playback and seeking do not re-hit the bridge.
