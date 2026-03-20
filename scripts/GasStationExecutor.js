const {ethers} = require("hardhat");

let {
    ADMIN,
    RELAYER
} = process.env;

RELAYER = RELAYER.replace(/,/g, "").replace(/"/g, "").replace(/'/g, "").replace(/\[/g, "").replace(/\]/g, "").split(" ");

async function main() {
    const implementation = await ethers.deployContract("GasStationExecutor");
    console.log("implementation deployed: ", implementation.target);

    await new Promise(x => setTimeout(x, 15000));

    const proxy = await ethers.deployContract("TransparentUpgradeableProxy", [implementation.target, ADMIN, implementation.interface.encodeFunctionData("initialize", [ADMIN, RELAYER])]);
    console.log("proxy deployed: ", proxy.target);

    const proxyAdmin = await ethers.getContractAt("ProxyAdmin", ethers.getCreateAddress({from: proxy.target, nonce: 1}));
    console.log("proxyAdmin address: ", proxyAdmin.target);

    await new Promise(x => setTimeout(x, 15000));
    await verify(implementation, [], false);

    await new Promise(x => setTimeout(x, 15000));
    await verify(proxy, [implementation.target, ADMIN, implementation.interface.encodeFunctionData("initialize", [ADMIN, RELAYER])], true);

    await new Promise(x => setTimeout(x, 15000));
    await verify(proxyAdmin, [ADMIN], true);
}

async function verify(contract, constructorArguments, isForce) {
    await hre.run("verify:verify", {
        address: contract.target,
        constructorArguments: constructorArguments,
        force: isForce
    })
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});