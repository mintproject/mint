# Run the model wizard

When you confirm your framing, DYNAMO opens the run model wizard for your task. It is a list of steps down the side of the page. Work through them in order. Each step narrows the next, and the setup is ready to run only when every required input has data. The suggestions you ticked while framing are already filled in, so you are reviewing and refining them, not starting again.

## The steps

1. **Framing.** Confirm the goal, region and time period. These decide which datasets you are shown later, so check them now rather than after you have picked models.
2. **Variables** (titled *Outcome & drivers*). Choose the result you want the model to produce. If you want to investigate one factor, choose a *driver*, such as rainfall, to vary. DYNAMO suggests drivers from the models and transformations that can produce your outcome. You confirm the choice, because the outcome decides which models are relevant.
3. **Models.** Choose one or more calibrated models. Each card shows what it produces and which inputs can become drivers and datasets. Pick models that produce your outcome and whose inputs you can supply. A **flow**, a model made of linked steps, shows a **Flow** badge. You can choose a flow here as you would a model. See [Run a flow](run-a-flow.md).
4. **Datasets.** Give every input of every model a dataset. Each model is set up on its own, so a dataset chosen for one model does not carry over to another. Search by name, source or variable, and check the coverage shown: full, partial, unknown, or outside the model's time window. Partial or missing coverage can give misleading results, so prefer full coverage.
   An input marked **Takes a collection** reads several files together as one input, so the whole selection is one run. If you do not have the data yet, **Upload files** on the input adds your files to the catalog as a new dataset. See [Run a flow](run-a-flow.md#start-a-flow-from-a-thread).
5. **Parameters.** Review the settings for each model and enter values for your scenario. Use the defaults, accepted values and units shown. These choices define your scenario, so pick values you can explain to the people who will read the result. A flow can arrive with some settings already fixed by its author. Those are shown with the value the author chose.
6. **Runs.** For a model, set the maximum run time in minutes (it starts at 60), then select **Send Runs**. Flows do not have a maximum run time. Before a flow starts, you may be asked to accept the settings its author chose, and to agree to any data it sends outside DYNAMO. A flow's progress is shown as a graph of its steps. Refresh to see progress. The plain-language status tells you whether it is waiting, running, finished, failed or waiting for your edit. Open the log only if something goes wrong.
   When the thread has more than one model, the Runs step's summary counts the models whose runs have all finished. It reads "1 of 3 complete" while some are finished and not all, and "Complete" when every model is done.
7. **Results.** Read the outputs for each model. The step opens as soon as any model in the thread has a successful run. See [Review results](results.md).
8. **Summary.** A read-back of every choice you made: framing, variables, models, datasets and parameters. Use it to check the setup, or to explain it to a colleague.

## Why the order matters

Region and dates come first because they limit which data you can pick. The outcome comes before the models because it decides which models make sense. Data comes before parameters so the values you set are chosen with your inputs already in place. If you change an early step, such as the region, check the later ones again, because earlier choices can change what is available below them.

## Before you submit a run

Check for missing inputs, incomplete coverage and invalid values. Fixing them first is faster than waiting for a failed run. If a model has no dataset available for one of its inputs, see [Troubleshooting](../troubleshooting.md).
