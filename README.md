# 39th War Room

A Tampermonkey userscript for Torn, for members of the 39th factions only.

It opens from a **39th War Room** bar on your own faction page, under Torn's war list, and stays open as you move around Torn until you close it.

Press **Own window** in its header to move it into a small browser window of its own. That window never changes page, so War Room stays up, without reloading, while you play Torn in your main window.

## What it shows

- Enemy members by status, with hospital and jail timers that follow Torn's clock
- **Out of hospital next**: the five soonest, in time order
- Both chains, the war score and the target
- Dibs from the 39th site, with your dibs limit
- Battle stats from the site's spies or from Battle Stats Predictor (your choice), and fair fight
- Targets assigned to you, and who has revives on
- Alerts: a dibbed target leaving hospital, several enemies leaving hospital early (push warning), and an optional chain-timeout alert

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [install link](https://raw.githubusercontent.com/Eaglewing91/39th-War-Room/main/39th-War-Room.user.js) and let Tampermonkey install it. Tampermonkey will offer new versions from here.
3. On your faction page, press **39th War Room**, press **Key**, and save a Torn API key. A **Public** key is enough.
4. Press **Site**, then **Turn on**, to use the 39th site. You must be logged in to [ultimata.net](https://ultimata.net/) in the same browser.

Built for desktop browsers with Tampermonkey. Torn PDA is not supported.

## Terms of use

| | |
|---|---|
| Data Storage | Only locally: your settings and your API key. The last reading is kept on this device for under a minute, so the window can carry on when you change Torn page. |
| Data Sharing | Nobody. A dib you place is sent to ultimata.net and shown to your faction there. |
| Purpose of Use | Competitive advantage: faster war status and dibs during ranked wars. |
| Key Storage & Sharing | Stored locally, used only for Torn API calls. Not shared; never sent to ultimata.net. |
| Key Access Level | Public. |

Services it can link to, both optional:

- [ultimata.net](https://ultimata.net/), the 39th site
- [Battle Stats Predictor](https://www.torn.com/forums.php#/p=threads&f=67&t=16290324) by TDup. Its saved figures on your device are read; no request is made for them.

## Torn scripting rules

- Torn requests are API only (`api.torn.com`), capped at 40 calls a minute. No requests to Torn pages, no scripted clicks.
- The faction page is read only to place the button. Attack links are ordinary links you click yourself.
- 39th factions only: your faction is read through the Torn API and checked on your device. For any other faction the script stops.

For staff review:

- With **Site** on, the script reads ultimata.net once a second and sends dibs there over a Socket.IO long-polling connection. Nothing is sent to that site except your browser's own login for it, the war number, your faction and player IDs, and the dibs you place.

## Status

Tested against mocked data only so far, not in a live war.

## Author

Eaglewing [571041]. Licence: GPL-3.0-or-later.
