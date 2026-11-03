# Installing Armillary on your Mac

Armillary is free and made by one person. It is not signed with a paid Apple Developer ID and not checked by Apple (this check is called notarization). Because of that, the first time you open it your Mac shows a warning and will not open it until you say you trust it. You only do this once. After that it opens like any other app.

These steps follow Apple's own instructions, checked on 2 November 2026 (sources at the end).

## Before you start

- You need a Mac with Apple silicon (M1 or later). To check, open the Apple menu and choose About This Mac. If the Chip line names Apple M1 or later, you are fine. If it says Intel, this build will not run.
- Only open apps from people you trust. Apple's guide warns that overriding security settings to open an app is the most common way a Mac gets infected with malware. Download Armillary only from its official GitHub release page, never from a copy someone sent you.

## Step 1. Download and put it in Applications

Pick one of the two downloads.

**The disk image (`Armillary-0.1.1.dmg`)**

1. Double-click the downloaded `.dmg` file. A window opens with the Armillary icon and an Applications folder.
2. Drag the Armillary icon onto the Applications folder.
3. Close the window, then eject the disk image (click the eject button next to Armillary in the Finder sidebar).

**The zip (`Armillary-0.1.1.app.zip`)**

1. Double-click the downloaded `.zip` file. Your Mac unpacks it into `Armillary.app` in the same folder. (Safari may already have unpacked it for you, in which case you will find `Armillary.app` in Downloads.)
2. Drag `Armillary.app` into the Applications folder.

## Step 2. Try to open it once

1. Open your Applications folder and double-click Armillary.
2. A warning appears saying Apple could not verify that Armillary is free of malware. The exact wording changes between macOS versions.
3. Click **Done**. Do not click **Move to Trash** (on some Macs it says Move to Bin).

This first try is needed. It is what makes the button in the next step appear.

## Step 3. Allow it in System Settings

1. Open the Apple menu and choose **System Settings**.
2. Click **Privacy & Security** in the sidebar. You may need to scroll the sidebar down to see it.
3. Scroll down the right side to the **Security** section. You will see a line saying Armillary was blocked.
4. Click **Open Anyway** next to it. (Apple's guide for the newest macOS calls this first button **Open** and then asks you to click **Open Anyway**. Click whichever your Mac shows.)
5. Type your Mac login password, or use Touch ID, and click **OK**.
6. The warning comes back one more time. Click **Open** (or **Open Anyway**).

The order of these prompts can differ between macOS versions. Either order is fine.

The button in Security is only there for about an hour after you tried to open the app. If you do not see it, go back to Step 2 and try to open Armillary again, then return here.

Armillary now opens, and from now on you can open it by double-clicking, like any other app.

## The right-click shortcut, on older macOS only

On macOS 14 Sonoma and earlier, there is a quicker way. In your Applications folder, hold the Control key and click Armillary (or right-click it), choose **Open**, then click **Open** in the message that appears.

On macOS 15 Sequoia and later this shortcut no longer works. Apple removed it in 2024, so use Step 3 instead. To see your version, open the Apple menu and choose About This Mac.

## When you open it

The first time Armillary runs, it plays a short title sequence and shows a plaque asking your permission to read your agents' history. Nothing is read until you choose to allow it. Choose "Not now" and nothing is read.

## If something goes wrong

**macOS says Armillary is damaged.** The download may be incomplete. Delete it, download it again, and if you can, check it against the checksum on the release page. In Terminal, run

```sh
shasum -a 256 ~/Downloads/Armillary-0.1.1.dmg
```

and compare the long code it prints with the one in `SHA256SUMS` on the release page. They must match exactly. For the zip, use `~/Downloads/Armillary-0.1.1.app.zip` instead. If Safari already unpacked the zip, there is nothing left to check. Download and check the `.dmg` instead.

**Only if the checksum matches and you trust the download**, this Terminal command removes the "downloaded from the internet" mark from the app, so macOS stops blocking it. It turns off this check for Armillary only.

```sh
xattr -dr com.apple.quarantine /Applications/Armillary.app
```

**No Open Anyway button.** Try to open the app again (Step 2), then go straight back to Privacy & Security. The button only stays for about an hour.

**It will not open on an Intel Mac.** This build runs on Apple silicon only.

## Removing Armillary

1. Open Armillary and choose **Delete archive and reset** in the side rail. This removes the archive it made and your first-run choice.
2. Quit Armillary and drag it from Applications to the Trash.

If you skip step 1, you can delete its folder by hand after quitting. In Finder, choose Go, then Go to Folder, and enter `~/Library/Application Support/com.armillary.app`. Move that folder to the Trash. Armillary never changes your agents' own files, so there is nothing else to undo.

## Sources

All checked on 2 November 2026 (US Central).

- Apple Support, "Open a Mac app from an unknown developer", Mac User Guide (the version shown was macOS 27), https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac. Source of "Overriding security settings to open an app is the most common way that a Mac gets infected with malware" and of the steps "choose Apple menu > System Settings, then click Privacy & Security in the sidebar", "Go to Security, then click Open", "Click Open Anyway", "This button is available for about an hour after you try to open the app" and "Enter your login password, then click OK".
- Apple Support, "Safely open apps on your Mac" (published 27 May 2026), https://support.apple.com/en-us/102445. Source of "click the Open Anyway button" and "The warning prompt reappears and, if you're absolutely sure that you want to open the app anyway, you can click Open". Its example warning reads "Apple cannot check 'Example App' for malicious software" with the buttons Move to Trash and Done.
- Apple Developer News, "Updates to runtime protection in macOS Sequoia" (6 August 2024), https://developer.apple.com/news/?id=saqachfa. Source of "In macOS Sequoia, users will no longer be able to Control-click to override Gatekeeper when opening software that isn't signed correctly or notarized."
- Apple silicon only, from the 0.1.0 build (`lipo -archs` printed `arm64`, checked 2 November 2026). The data folder `~/Library/Application Support/com.armillary.app` was seen on a real install the same day.

These steps were written from Apple's pages. They have not yet been walked through on a fresh download of the 0.1.1 build.
