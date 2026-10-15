<h1 align="center">
<sub>
<img src="https://raw.githubusercontent.com/devofthedark/AnyDownload/refs/heads/main/src/logo/icon.svg" height="38", width="38">
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
- **Logged-in downloads**: check **Use Cookies** to use the cookies from your existing browser session, so content you can access while signed in is content you can download.

## Installation
 

| Browser | Install Method |
| --- | --- |
| Firefox | Install from **[Firefox Add-ons][amo-link]** |
| Microsoft Edge | Install from **[Edge Add-ons][edge-link]** |
| Other Chromium-based (Chrome, Brave, etc.) | See instructions below |

<a name="chromium-install"></a>
### Chromium-based browsers (Chrome, Brave, etc.)

1. Download `anydownload-<version>-chrome.zip` from the [releases][Releases] page.
2. Extract the zip file.
3. Go to `chrome://extensions` and toggle on `Developer Mode` at the top right corner.
4. Click on `Load unpacked` at the top left corner.
5. Select the folder where you extracted the zip file to.

> [!WARNING]
> Make sure you download the file ending with `-chrome.zip`, not `-chrome-store.zip`. The `chrome-store` version is intended
> for release on the Chrome Web Store and as thus does not have all the features of the `chrome` version, namely
> automatic updates and downloading from YouTube.

#### Updating

The Chromium version checks GitHub for a new release about twice a day, and the AnyDownload panel says when there is
one. Click `Update` to download it, then follow the steps on the page that opens:

1. Extract the downloaded zip file.
2. Replace everything in the folder AnyDownload is loaded from (shown on its details page in `chrome://extensions`)
   with the extracted files.
3. Click `Reload AnyDownload`.

Replacing the files keeps your settings. You can also remove AnyDownload and load the new folder instead, but then you
have to accept the terms of use again. To check for updates yourself, or to turn the automatic checks off, click the
version number at the bottom of the panel.

## How it works
 
AnyDownload runs yt-dlp inside the extension using [Pyodide][pyodide] (CPython compiled to WebAssembly). Media processing (merging streams, remuxing, converting formats) is done by Mediabunny, also bundled in the extension. Nothing leaves your browser except the requests to the sites you are downloading from.
 
**Large files.** WebAssembly is limited to 4 GB of memory. AnyDownload gets around this by using the [Origin Private File System (OPFS)](https://developer.mozilla.org/docs/Web/API/File_System_API/Origin_private_file_system) for storage instead of holding everything in memory.
 
**YouTube.** YouTube requires solving a JavaScript challenge. AnyDownload executes it in a sandbox.
 
## Limitations
 
- **No DRM-protected content.** AnyDownload cannot download media protected by DRM.
- **Firefox site access.** Firefox lets you turn off an add-on's access to websites, and AnyDownload can't download
  from most sites without it. If it's off, the panel says so: click `Allow access` there, or turn on "Access your data
  for all websites" in AnyDownload's Permissions tab in `about:addons`.
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

This writes `dist/anydownload-<version>-<target>.zip` for the `chrome`, `chrome-store`, `edge-store`, `opera-store`
and `firefox` targets, plus an unpacked copy of each in `dist/<target>/` for loading into the browser. The
`chrome-store` build is the Chromium build for the Chrome Web Store, with the panel's notice that the browser has
updated AnyDownload (in `src/whatsnew/`) in place of the update checker. As the Chrome Web Store doesn't allow
downloading from YouTube, on YouTube that build shows a notice saying so in place of the panel, and refuses YouTube videos embedded in other
sites (in `src/chrome-store/`). The `edge-store` build is the Chromium build adjusted for the Edge Add-ons store, which
rejects packages that contain a `.zip` file. Only the `chrome` build has the update checker (in `src/updater/`), as the
browser updates store installs itself. Only the `firefox` build has the panel's notice for when Firefox hasn't given
AnyDownload access to websites (in `src/firefox/`).

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
[edge-link]: https://microsoftedge.microsoft.com/addons/detail/anydownload/icpkdhomdhnooolmlgipoiaejfoadcfb

