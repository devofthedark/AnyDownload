<h1 align="center">
<sub>
<img src="https://raw.githubusercontent.com/devofthedark/AnyDownload/refs/heads/main/logo/icon.svg" height="38", width="38">
</sub>
AnyDownload
</h1>

Download videos from anywhere you can name with the power of [yt-dlp][yt-dlp], 
now fully in the browser.

Simply install the extension and download from any site that you can name. No companion app required. Runs fully locally on your machine in the browser.

> [!NOTE]
> This project is not affiliated with the [yt-dlp][yt-dlp] project. It is an independent project.

## Installing

### Firefox

1. Download `anydownload-<version>-firefox.zip` from the [releases][Releases] page.
2. Extract the zip file.
3. Go to `about:debugging` > `This Firefox` and click on `Load Temporary Add-on...`
4. Open `manifest.json` from the extracted zip file.

### Chromium

1. Download `anydownload-<version>-chrome.zip` from the [releases][Releases] page.
2. Extract the zip file.
3. Go to `chrome://extensions` and toggle on `Developer Mode` at the top right corner.
4. Click on `Load unpacked` at the top left corner.
5. Select the folder where you extracted the zip file to.



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

[yt-dlp]: https://github.com/yt-dlp/yt-dlp
[Releases]: https://github.com/devofthedark/AnyDownloads/releases