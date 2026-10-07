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

Install from [Firefox add-ons](https://addons.mozilla.org/en-US/firefox/addon/anydownload/).

### Chromium

1. Download `anydownload-<version>-chrome.zip` from the [releases][Releases] page.
2. Extract the zip file.
3. Go to `chrome://extensions` and toggle on `Developer Mode` at the top right corner.
4. Click on `Load unpacked` at the top left corner.
5. Select the folder where you extracted the zip file to.

#### Updating

The Chromium version checks GitHub for a new release about twice a day, and the AnyDownload panel says when there is
one. Click `Update` to download it, then follow the steps on the page that opens:

1. Extract the downloaded zip file.
2. Replace everything in the folder AnyDownload is loaded from (shown on its details page in `chrome://extensions`)
   with the extracted files.
3. Click `Reload AnyDownload`.

Replacing the files keeps your settings. You can also remove AnyDownload and load the new folder instead, but then you
have to accept the terms of use again. To check for updates yourself, or to turn the automatic checks off, click the
version number at the bottom of the panel. Pre-releases are never offered.

Version 1.0.0 doesn't check for updates, so update it by hand the same way: replace its files, then click the reload
button on its card in `chrome://extensions`.


## Building

To install the necessary dependencies, run

```sh
npm ci
```

To build the store packages (needs `zip` installed on PATH):

```sh
npm run package
```

This writes `dist/anydownload-<version>-chrome.zip`, `dist/anydownload-<version>-edge-store.zip` and
`dist/anydownload-<version>-firefox.zip`, plus unpacked copies in `dist/chrome/`, `dist/edge-store/` and `dist/firefox/`
for loading into the browser. The `edge-store` build is the Chromium build adjusted for the Edge Add-ons store, which
rejects packages that contain a `.zip` file. Only the `chrome` build has the update checker (in `updater/`), as the
browser updates store installs itself.

## Credits

The logo is a modified version of the "world-download" icon from [Tabler Icons](https://tabler.io/icons).

[yt-dlp]: https://github.com/yt-dlp/yt-dlp
[Releases]: https://github.com/devofthedark/AnyDownload/releases
