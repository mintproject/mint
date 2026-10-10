# RAS Commander on Windows: run and remote backends

Research for [#332](https://github.com/mintproject/monorepo/issues/332). Part of #330. Checked on 2026-10-10.

## Answer

1. RAS Commander runs HEC-RAS on Windows 10/11 with HEC-RAS 6.0 or later. Older versions (3.x to 5.x) need the COM backend.
2. No backend exposes a network API. PsExec and Docker-over-SSH let a controller drive a remote machine. MINT needs its own small service on the Windows machine, or a controller that uses PsExec.
3. HEC-RAS is free to use, including headless. Redistribution is allowed if the recipient accepts the HEC terms. Unattended runs need the terms accepted for the exact release and user.

## Requirements

- Python 3.10 or later. The docs recommend 3.13. [Installation](https://rascommander.info/ras/getting-started/installation/)
- Windows runs the full HEC-RAS `Ras.exe`. Linux does map generation through Wine. Mac does HDF analysis only. [Installation](https://rascommander.info/ras/getting-started/installation/)
- The `ras-commander[compute]` extra does not install HEC-RAS or Wine. It adds `psutil` and, on Windows, `pywin32`. [Installation](https://rascommander.info/ras/getting-started/installation/)
- HEC-RAS 6.0 or later is recommended. Versions 3.x to 5.x work through `RasControl` (COM). [Installation](https://rascommander.info/ras/getting-started/installation/)
- Each HEC-RAS instance needs about 2 to 4 GB of RAM. [Plan execution](https://rascommander.info/ras/user-guide/plan-execution/)
- Latest release at the time of writing: [v0.104.0](https://github.com/gpt-cmdr/ras-commander/releases/tag/v0.104.0).
- The code is MIT licensed. [LICENSE](https://github.com/gpt-cmdr/ras-commander/blob/main/LICENSE)

## Backends

Source for the table: [Execution backends](https://rascommander.info/ras/user-guide/execution-backends/) and [Remote execution](https://rascommander.info/ras/user-guide/remote-execution/).

| Backend | Runs on | Reaches another machine? | Notes |
|---|---|---|---|
| `LocalWorker` / `RasCmdr` | Windows | No | Local processes. Baseline. |
| `PsexecWorker` | Windows worker | Yes, over SMB and PsExec | Needs a logged-in user session. See below. |
| `RasDocker` | Windows or Linux host with Docker | No, local Docker CLI | Wine preprocess, then native Linux solve. One plan per container. |
| `DockerWorker` | Local or remote Docker | Yes, `ssh://` Docker host | Needs an image that follows the `run_ras.sh` contract. Key-based SSH. |
| `RasPortableDocker` | Linux container | No | Portable steady and unsteady requests. |
| `RasSlurm` / `RasApptainer` | Slurm cluster | Yes, local scheduler or SSH | `RasApptainer` 6.6 profile has no live qualification through this API. |
| `RasControl` (COM) | Windows | No | Legacy. See below. |
| `SshWorker`, `WinrmWorker`, `SlurmWorker`, `AwsEc2Worker`, `AzureFrWorker` | None | None | Stubs. `init_ras_worker("slurm", ...)` raises `NotImplementedError`. |

## PsExec worker

PsExec is the only backend that runs HEC-RAS on a remote Windows machine. Facts from [Remote execution](https://rascommander.info/ras/user-guide/remote-execution/):

- The worker is Windows 10 or 11 with HEC-RAS 5.x to 7.x installed.
- HEC-RAS is a GUI program. It must run in a user session. Never use `system_account=True`. HEC-RAS hangs.
- A user must stay logged in to that session. This blocks a headless server.
- The account must be a local administrator.
- The worker needs a shared folder, port 445, Remote Registry, and the registry key `LocalAccountTokenFilterPolicy=1`. A reboot follows.
- The controller needs `PsExec.exe`. The first connection takes 5 to 15 seconds.
- `compute_parallel_remote()` spreads plans over many workers and collects results locally.
- Batch files must use local paths, not UNC paths.

## Docker backends

- `RasDocker` supports HEC-RAS 6.5, 6.6 and 7.0.1. Images are `rascommander/hec-ras-wine-precompute_<version>:v4` and `rascommander/hec-ras-linux-unsteady_<version>:v1`. Versions must match. [Container execution](https://rascommander.info/ras/user-guide/container-execution/)
- A Windows host needs Docker Desktop with Linux containers. HEC-RAS does not need to be installed on the host. [Container execution](https://rascommander.info/ras/user-guide/container-execution/)
- The native solver covers unsteady flow only. The model needs populated 2D meshes. [Container execution](https://rascommander.info/ras/user-guide/container-execution/)
- Cores: 1 to 8 per container. [Container execution](https://rascommander.info/ras/user-guide/container-execution/)
- Images are linux/amd64 only. [README](https://github.com/gpt-cmdr/ras-commander)
- HEC publishes a Linux compute build. It needs WSL on Windows and runs slower than native Windows engines. [HEC-RAS downloads](https://www.hec.usace.army.mil/software/hec-ras/download.aspx)

## Legacy COM (`RasControl`)

Source: [Legacy COM interface](https://rascommander.info/ras/user-guide/legacy-com-interface/).

- Windows only. Needs `pywin32`.
- Versions: 3.x (as 4.1), 4.0, 4.1, 5.0.x, 6.0, 6.3, 6.6, 7.0.
- One HEC-RAS instance at a time per version.
- It is slower than command-line execution.
- For 4.0 and 4.1 the compute call blocks. A time limit needs an outside watchdog.
- Local only. The page has no remote use.
- Use it for old versions. Use `RasCmdr` for modern ones.

## HEC-RAS license for headless runs

- Use is not restricted. People outside USACE use HEC-RAS without charge. HEC gives no support to non-USACE users. [Downloads](https://www.hec.usace.army.mil/software/hec-ras/download.aspx)
- Using the software means you accept the HEC terms. [Terms and Conditions](https://www.hec.usace.army.mil/software/terms_and_conditions.aspx)
- You may copy and distribute it if the recipient accepts the same terms. [Terms and Conditions](https://www.hec.usace.army.mil/software/terms_and_conditions.aspx)
- You may not modify, decompile or reverse engineer it. [Terms and Conditions](https://www.hec.usace.army.mil/software/terms_and_conditions.aspx)
- Derived products may not carry the HEC-RAS name. [Terms and Conditions](https://www.hec.usace.army.mil/software/terms_and_conditions.aspx)
- Export laws apply. [Terms and Conditions](https://www.hec.usace.army.mil/software/terms_and_conditions.aspx)
- The terms say nothing about headless or server use. They have no per-seat or per-machine limit.
- RAS Commander says unattended Windows runs need the terms accepted for the exact installed release and current user. An unaccepted release fails preflight. [README](https://github.com/gpt-cmdr/ras-commander)
- The container docs give no license terms for HEC-RAS inside the images. [Container execution](https://rascommander.info/ras/user-guide/container-execution/)

## Fit for MINT (inference, not from the sources)

- MINT calls a Windows machine over the network. No backend gives that call. Run ras-commander on the Windows machine behind a small HTTP or queue service.
- Or run ras-commander on a Windows controller and use `PsexecWorker`. This needs a logged-in user, admin rights and SMB. Treat it as fragile for a server.
- For a Linux cluster, `RasDocker` or `RasApptainer` avoid a Windows host. They cover unsteady 2D models on 6.5, 6.6 and 7.0.1 only.
- Check the license question for images before MINT redistributes them. The sources do not answer it. Ask HEC.

## Gaps

- The HEC distribution policy page had no readable body. Redistribution inside container images is not confirmed.
- The old host `ras-commander.readthedocs.io` returns 404 for the pages that the task named. The docs now live at `rascommander.info/ras/`.
- The docs do not state a minimum Windows build for non-PsExec runs.
