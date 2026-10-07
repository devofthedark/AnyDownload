<h1 align="center">
<sub>
<img src="https://raw.githubusercontent.com/devofthedark/AnyDownload/refs/heads/main/logo/icon.svg" height="38", width="38">
</sub>
AnyDownload
</h1>
 
**Download media from almost any site, entirely inside your browser.**
 
AnyDownload is a browser extension powered by [yt-dlp][yt-dlp]. It runs 100% locally: there is no companion app to install, no additional helper programs, and no server in the middle. Everything happens inside the extension on your machine.
 
## Features
 
- **Works on a huge range of sites**: yt-dlp's extractors do the heavy lifting, so if yt-dlp can handle a site, AnyDownload can too.
- **Fully local**: no companion apps, no backend servers, no relaying your URLs or files through a third party.
- **Format and quality picker**: choose exactly which stream you want.
- **Convert to any output format**: powered by [Mediabunny][mediabunny], which is bundled with the extension and handles the muxing and conversion work you would normally use ffmpeg for.
- **Audio-only downloads**: save just the audio track.
- **Logged-in downloads**: uses the cookies from your existing browser sessions, so content you can access while signed in is content you can download.
## How it works
 
AnyDownload runs yt-dlp inside the extension using [Pyodide][pyodide] (CPython compiled to WebAssembly). Media processing (merging streams, remuxing, converting formats) is done by Mediabunny, also bundled in the extension. Nothing leaves your browser except the requests to the sites you are downloading from.
 
**Large files.** WebAssembly is limited to 4 GB of memory. AnyDownload gets around this by using the [Origin Private File System (OPFS)](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system) for storage instead of holding everything in memory.
 
**YouTube.** YouTube requires solving a JavaScript challenge. AnyDownload executes it in a sandbox.
 
## Installation
 
### Firefox
 
Install from **[Firefox add-ons][amo-link]**
 
### Chromium-based browsers (Chrome, Edge, Brave, etc.)

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

## Limitations
 
- **No DRM-protected content.** AnyDownload cannot download media protected by DRM.
- **Firefox private browsing.** OPFS is not available in Firefox private windows, so AnyDownload falls back to in-memory storage there. Very large downloads may hit memory limits in that mode.


## Disclaimer
 
Only download content you have the right to save. You are responsible for complying with the terms of service of the sites you use and with the laws that apply to you.

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

- [yt-dlp][yt-dlp]: the extraction engine
- [Pyodide][pyodide]: Python in WebAssembly
- [Mediabunny][mediabunny]: media muxing and conversion

The logo is a modified version of the "world-download" icon from [Tabler Icons](https://tabler.io/icons).

## License
 
AnyDownload is licensed under the [GNU General Public License v3.0](LICENSE.txt).

[yt-dlp]: https://github.com/yt-dlp/yt-dlp
[Releases]: https://github.com/devofthedark/AnyDownload/releases
[pyodide]: https://pyodide.org/
[mediabunny]: https://github.com/Vanilagy/mediabunny
[amo-link]: https://addons.mozilla.org/en-US/firefox/addon/anydownload

