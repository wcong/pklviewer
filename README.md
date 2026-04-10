# PKL Viewer

PKL Viewer adds a custom editor that renders Python pickle (PKL) files inside VS Code. It uses a local Python interpreter to load the file and shows a structured tree plus a raw representation.

## Features

- Open .pkl files in a custom editor view
- Tree view of the decoded data
- Raw repr view
- Refresh button to re-run the decode

## Requirements

- Python available on your PATH, or configure `pklviewer.pythonPath`

Security note: unpickling is code execution. Only open trusted PKL files.

## Extension Settings

- `pklviewer.pythonPath`: Python executable used to decode PKL files (default: `python`)
- `pklviewer.condaPythonPath`: Absolute path to conda environment python (overrides `pklviewer.pythonPath`)
- `pklviewer.maxOutputBytes`: Maximum bytes of decoded JSON allowed from Python (default: 5242880)
- `pklviewer.maxDepth`: Maximum depth when expanding objects (default: 8)

## Build and install

1. Install dependencies: `npm install`
2. Build the extension: `npm run compile`
3. Package a VSIX: `npx @vscode/vsce package`
4. Install the VSIX: `code --install-extension pklviewer-0.0.1.vsix`

## Automated Builds and Downloads

This repository uses GitHub Actions to automatically build and package the VSIX file.

- **Latest Build**: Download the latest VSIX from the [GitHub Actions artifacts](https://github.com/wcong/pklviewer/actions) (available for 90 days).
- **Releases**: For stable versions, create a GitHub Release to upload the VSIX. Download from the [Releases page](https://github.com/wcong/pklviewer/releases).

To install from a downloaded VSIX: `code --install-extension path/to/pklviewer.vsix`

## Development

Press `F5` in VS Code to launch the extension host and open a workspace with .pkl files. Use the command `PKL Viewer: Open PKL File` or open a .pkl file directly to use the custom editor.
