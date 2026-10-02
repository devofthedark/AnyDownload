# AnyDownload

Download videos from anywhere you can name with the power of [yt-dlp](https://github.com/yt-dlp/yt-dlp), 
now fully in the browser.

No external servers. No installing a companion app on your computer. Just click download and it downloads the video
and audio in full quality.

## Building

```sh
npm install
```

To build the store packages:

```sh
npm run package
```

This writes `dist/anydownload-<version>-chrome.zip` and `dist/anydownload-<version>-firefox.zip`, plus unpacked
copies in `dist/chrome/` and `dist/firefox/` for loading into the browser.