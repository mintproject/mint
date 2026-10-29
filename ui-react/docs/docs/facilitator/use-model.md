# Run the model wizard

When you confirm your framing, DYNAMO opens the run model wizard for your task. It is a list of steps down the side of the page. Work through them in order. Each step narrows the next, and the setup is ready to run only when every required input has data. The suggestions you ticked while framing are already filled in, so you are reviewing and refining them, not starting again.

## The steps

1. **Framing.** Confirm the goal, region and time period. These decide which datasets you are shown later, so check them now rather than after you have picked models.
2. **Variables** (titled *Outcome & drivers*). Choose the result you want the model to produce. If you want to investigate one factor, choose a *driver*, such as rainfall, to vary. DYNAMO suggests drivers from the models and transformations that can produce your outcome. You confirm the choice, because the outcome decides which models are relevant.
3. **Models.** Choose one or more calibrated models. Each card shows what it produces and which inputs can become drivers and datasets. Pick models that produce your outcome and whose inputs you can supply.
4. **Datasets.** Give every input of every model a dataset. Each model is set up on its own, so a dataset chosen for one model does not carry over to another. Search by name, source or variable, and check the coverage shown: full, partial, unknown, or outside the model's time window. Partial or missing coverage can give misleading results, so prefer full coverage.
5. **Parameters.** Review the settings for each model and enter values for your scenario. Use the defaults, accepted values and units shown. These choices define your scenario, so pick values you can explain to the people who will read the result.
6. **Runs.** Submit the run, set the maximum run time, and refresh to see its progress. The plain-language status tells you whether it is waiting, running, finished or failed. Open the log only if something goes wrong.
7. **Results.** Read the outputs for each model. See [Review results](results.md).
8. **Summary.** A read-back of every choice you made: framing, variables, models, datasets and parameters. Use it to check the setup, or to explain it to a colleague.

## Why the order matters

Region and dates come first because they limit which data you can pick. The outcome comes before the models because it decides which models make sense. Data comes before parameters so the values you set are chosen with your inputs already in place. If you change an early step, such as the region, check the later ones again, because earlier choices can change what is available below them.

## Before you submit a run

Check for missing inputs, incomplete coverage and invalid values. Fixing them first is faster than waiting for a failed run. If a model has no dataset available for one of its inputs, see [Troubleshooting](../troubleshooting.md).
