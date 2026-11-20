import Dockerode = require("dockerode");
import { imageExists, pullImageAsync } from "dockerode-utils";

const dockerode = new Dockerode();

export const pullImage = async (image: string) => {
    const exists = await imageExists(dockerode, image);
    if (!exists) {
        console.log("Pulling docker image: " + image);
        await pullImageAsync(dockerode, image);
    }
};

export const runImage = async (
    cmd: string[],
    image: string,
    logstream: NodeJS.WritableStream,
    workingDirectory: string,
    folderBindings: string[]
) => {
    // console.log(cmd)
    // console.log(folderBindings)
    // console.log(workingDirectory)
    // console.log(image)
    // console.log(cmd.join(" "))
    return dockerode.run(image, cmd, logstream, {
        WorkingDir: workingDirectory,
        Binds: folderBindings,
        EntryPoint: "",
        User: "1000:1000"
    });
};
