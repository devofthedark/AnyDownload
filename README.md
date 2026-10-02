# AnyDownload

Download videos from anywhere you can name with the power of [yt-dlp](https://github.com/yt-dlp/yt-dlp), 
now fully in the browser.

No external servers. No installing a companion app on your computer. Just click download and it downloads the video
and audio in full quality.

> [!NOTE]
> This project is not affiliated with the [yt-dlp](https://github.com/yt-dlp/yt-dlp) project. It is an independent project.

## Building

To install the necessary dependencies, run

```sh
npm ci
```

To build the store packages (needs `zip` installed on PATH):

```sh
npm run package
```

This writes `dist/anydownload-<version>-chrome.zip` and `dist/anydownload-<version>-firefox.zip`, plus unpacked
copies in `dist/chrome/` and `dist/firefox/` for loading into the browser.

## Credits

The logo is a modified version of the "world-download" icon from [Tabler Icons](https://tabler.io/icons).