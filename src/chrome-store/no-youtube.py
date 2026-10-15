# The chrome-store build's refusal to download from YouTube, which the Chrome Web Store doesn't allow (see
# doc/no-youtube-chrome.md). The panel doesn't open on YouTube itself (see no-youtube.js); this covers YouTube
# videos embedded in or linked from other sites, and YouTube's other frontends (e.g. Invidious instances).
# scripts/package.mjs has the worker run it right after dl.py, in the same namespace, to change its BrowserYDL.

class YouTubeNotSupported(yt_dlp.utils.YoutubeDLError):
    msg = "This video is on YouTube, and downloading from YouTube isn't supported in this version of AnyDownload."

class NoYouTubeYDL(BrowserYDL):
    def get_info_extractor(self, ie_key):
        """Every extractor yt-dlp runs is got here first, however it came to it: the page's own URL, or an embed
        or link another extractor found there. YouTube's extractors are all called Youtube*. Looking for embeds
        in a page doesn't come through here for YouTube's, so other sites' pages are still looked through"""
        if ie_key.startswith('Youtube'):
            raise YouTubeNotSupported()
        return super().get_info_extractor(ie_key)

# what list_formats and download make theirs from
BrowserYDL = NoYouTubeYDL
