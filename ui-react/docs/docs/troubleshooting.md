# Troubleshooting

## I cannot find a model or dataset I expected

Search results depend on how the item was described, so first check your own filters, then the description.

1. Clear the **Region**, **Category** and **Output variable** filters, then add them back one at a time. A narrow region or period is the most common reason something disappears.
2. Search by a variable name as well as by a topic word. Datasets are tagged with variable names.
3. Check the dataset's time and map coverage against your question.
4. If it still is not there, it may not have been described fully. Ask the person who owns it to check that it has a variable, a unit, a format and a region. [Why the details you enter matter](reference/why-metadata.md) explains what to ask for.

## A model has no data to choose for one of its inputs

The data step offers datasets that carry the same standard variable as the input. If nothing is offered, no dataset with that variable covers your place and period, or the model input was registered without a variable. Try a wider region or period, or ask the model's author to add the variable.

## A model I registered does not appear where I expect

Check three things on its details: it has a component location (a configuration without one can be described but not run), its inputs and outputs have variables and units, and its region is not limited to somewhere other than where you are looking. Turn on **My models** in **Browse Models** to see only your own.

## My application is not in the list when I register a model

The list shows the applications your signed-in account can use: your own, those shared with you, and public ones. Check that the application was created with the same account you are signed in with, that it is enabled, and that the id and version are what you expect. A brand-new application can take a moment to appear, so reload the page. If it is still missing, ask the person who manages your TACC project to confirm your account has access to it.

## Creating an application says it already exists

An application with that id and version is already in Tapis, possibly under another account. Each version can only be created once, so raise the **version** in your `app.json`, or choose a different **id**, and create it again.

## The application was created but could not be made public

The application exists and only you can run it. Select **Make public** in the dialog to try again. If it keeps failing, your account may not be allowed to share applications, so ask a Tapis administrator.

## I need to undo a public application

DYNAMO cannot make an application private or remove it. Ask the application's owner or a Tapis administrator to do it in Tapis.

## A page says it failed to load

Reload the page and try again. If you were signed in, try signing out and back in. If it keeps happening, note the page and the time and report it.

## A flow asks for saved credentials

The dialog is titled *Saved credentials needed*. The flow calls an outside service that needs a key or password, and you have not stored it yet. Select **Open saved credentials**, add the credential with the names the dialog lists, and start the run again. See [Saved credentials](saved-credentials.md).

## I cannot change a saved credential

The page says *You have a run in progress. Change this credential when it has finished.* A credential cannot be saved, replaced or deleted while one of your runs is in progress. Wait for the run to finish, then try again.

If the page says you have changed credentials too many times, wait a few minutes and try again.

## A flow says it needs a setting filled in

Some settings have no default and no value. Give each one a value in the **Parameters** step, save, then run again. The message lists the settings it needs.

## A flow says it is already running

The message gives the name of the run already in progress. Wait for that run to finish, or cancel it from the flow's card in the Runs step, then run again.

## A step says Not runnable for you

The step's piece has been removed, is not visible to your account, or has not been approved for your account. Ask the flow's owner to check the step. Pieces that are shared or public need an administrator's approval, and their status is listed at `/etl/approvals`.

## A collection input or file was refused

The message says *This input takes one file*, or it names a file that cannot be used. Change the selection in the **Datasets** step, keeping only the files the input takes, then run again. An upload takes up to 500 files at once, and 2 GB in all.

## A run is waiting for my edit, but I cannot upload

Only the person who started the run can upload the edited file and resume it. Anyone else sees a line naming that person. Ask them to continue the run.

## My edited file was not accepted

The panel says *The last edit could not be used*, with the reason. Download the file again if you need the original, make the change, upload the corrected copy, and select **Resume with this edit**.

## A paused run was cancelled

A run left waiting for 14 days is cancelled. Start the flow again from the Runs step.

## I cannot create a dataset in any organisation

The upload page says *You cannot create datasets in any catalog organisation*. Ask a catalog administrator to add you to one. See [Upload a dataset](data-scientist/upload-a-dataset.md).

## A model cannot read the dataset I uploaded

A model reads its files directly, so it can use only public files. Upload the files again with **Make public** ticked, or, for a flow, keep the dataset private. A flow can read private files.

## Saved credentials are not available on this server yet

The server that stores credentials is not set up here. Ask your DYNAMO administrator.

## When you ask for help

Give the page you were on, what you chose, and any message you saw. For a run, include its name and the message shown. Never send your password or sign-in details to anyone.
