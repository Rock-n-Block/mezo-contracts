const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("GasStationExecutor", () => {
    async function deployFixture() {
        const [deployer, admin, relayer, user] = await ethers.getSigners();

        const GasStationExecutor = await ethers.getContractFactory("GasStationExecutor");
        const executor = await upgrades.deployProxy(GasStationExecutor, [admin.address, [relayer.address]]);

        const token1 = await ethers.deployContract("MockToken");
        const token2 = await ethers.deployContract("MockTokenWithFee");
        const router = await ethers.deployContract("MockRouter");

        await token1.mint(user, "10000");
        await token1.mint(router, "10000");
        await token2.mint(user, "10000");
        await token2.mint(router, "10000");
        await deployer.sendTransaction({to: router, value: 10000});

        const permitDomain = {
            name: "name",
            version: "1",
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: ""
        }

        const permitTypes = {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        }

        const swapFunction = (await ethers.getContractFactory("MockRouter")).interface.getFunction("mockSwap");

        const domain = {
            name: "GasStationExecutor",
            version: "1",
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: executor.target
        }

        const types = {
            ExecuteSwap: [
                { name: "token", type: "address" },
                { name: "swapData", type: "SwapData" },
                { name: "feeAmount", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ],
            SwapData: [
                { name: "executionContract", type: "address" },
                { name: "functionSignature", type: "string" },
                { name: "executionCalldata", type: "bytes" },
                { name: "outputToken", type: "address" },
                { name: "receiver", type: "address" },
                { name: "inputAmount", type: "uint256" },
                { name: "minAmountOut", type: "uint256" }
            ]
        }

        return {deployer, admin, relayer, user, token1, token2, router, permitDomain, permitTypes, swapFunctionSignature: swapFunction.format(), swapFunctionSelector: swapFunction.selector, executor, domain, types};
    }

    it("Initializer, access control", async () => {
        let {deployer, admin, relayer, user, token1, token2, router, permitDomain, permitTypes, swapFunctionSignature, swapFunctionSelector, executor, domain, types} = await loadFixture(deployFixture);

        await expect(executor.connect(admin).initialize(admin, [relayer])).revertedWithCustomError(executor, "InvalidInitialization");

        await expect(executor.connect(relayer).pause()).revertedWithCustomError(executor, "AccessControlUnauthorizedAccount").withArgs(relayer, await executor.DEFAULT_ADMIN_ROLE());
        await expect(executor.connect(relayer).unpause()).revertedWithCustomError(executor, "AccessControlUnauthorizedAccount").withArgs(relayer, await executor.DEFAULT_ADMIN_ROLE());
        await expect(executor.connect(relayer).setWhitelistedSelectors([],[],[])).revertedWithCustomError(executor, "AccessControlUnauthorizedAccount").withArgs(relayer, await executor.DEFAULT_ADMIN_ROLE());
        await expect(executor.connect(relayer).getToken(token1, admin, 0)).revertedWithCustomError(executor, "AccessControlUnauthorizedAccount").withArgs(relayer, await executor.DEFAULT_ADMIN_ROLE());
        await expect(executor.connect(admin).executeSwap(ethers.ZeroAddress, ethers.ZeroAddress, [false,0,0,0,ethers.ZeroHash,ethers.ZeroHash], [ethers.ZeroAddress,"","0x",ethers.ZeroAddress,ethers.ZeroAddress,0,0], [ethers.ZeroAddress,"0x00000000","0x",0], 0, "0x")).revertedWithCustomError(executor, "AccessControlUnauthorizedAccount").withArgs(admin, await executor.RELAYER_ROLE());
    })

    describe("Main functionality", () => {
        it("Signatures, deadline, nonces", async () => {
            let {deployer, admin, relayer, user, token1, token2, router, permitDomain, permitTypes, swapFunctionSignature, swapFunctionSelector, executor, domain, types} = await loadFixture(deployFixture);

            await executor.connect(admin).unpause();

            let deadline = await time.latest() + 60;

            permitDomain.verifyingContract = token1.target;
            let permitValues = {
                owner: user.address,
                spender: executor.target,
                value: 2000,
                nonce: 0,
                deadline
            }

            let {r,s,v} = ethers.Signature.from(await user.signTypedData(permitDomain, permitTypes, permitValues));

            let permitInfo = {
                required: true,
                value: 2000,
                deadline,
                v,
                r,
                s
            }

            let abiCoder = new ethers.AbiCoder();

            let swapData = {
                executionContract: router.target,
                functionSignature: swapFunctionSignature,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token1.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", user.address, 1000, 100]),
                outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                receiver: user.address,
                inputAmount: 1000,
                minAmountOut: 100
            }

            let feeSwapData = {
                executionContract: router.target,
                functionSelector: swapFunctionSelector,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token1.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", admin.address, 10, 1]),
                inputAmount: 20
            }

            deadline = await time.latest();

            let signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 1, deadline));
            await time.setNextBlockTimestamp(deadline + 1);
            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "DeadlinePassed").withArgs(deadline, deadline + 1);

            deadline = permitInfo.deadline;

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 1, deadline));
            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "InvalidSignature");

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 0, deadline));
            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "InvalidFunctionCall");
        })

        it("Main functionality", async () => {
            let {deployer, admin, relayer, user, token1, token2, router, permitDomain, permitTypes, swapFunctionSignature, swapFunctionSelector, executor, domain, types} = await loadFixture(deployFixture);

            let deadline = await time.latest() + 60;

            permitDomain.verifyingContract = token1.target;
            let permitValues = {
                owner: user.address,
                spender: executor.target,
                value: 2000,
                nonce: 0,
                deadline
            }

            let {r,s,v} = ethers.Signature.from(await user.signTypedData(permitDomain, permitTypes, permitValues));

            let permitInfo = {
                required: true,
                value: 2000,
                deadline,
                v,
                r,
                s
            }

            let abiCoder = new ethers.AbiCoder();

            let swapData = {
                executionContract: router.target,
                functionSignature: swapFunctionSignature,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token1.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", user.address, 1000, 100]),
                outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                receiver: user.address,
                inputAmount: 1000,
                minAmountOut: 101
            }

            let feeSwapData = {
                executionContract: router.target,
                functionSelector: swapFunctionSelector,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token1.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", admin.address, 50, 10]),
                inputAmount: 100
            }

            let signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 0, deadline));
            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "EnforcedPause");

            await executor.connect(admin).unpause();

            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "InvalidFunctionCall").withArgs(router, swapFunctionSelector);

            await executor.connect(admin).pause();

            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "EnforcedPause");

            await executor.connect(admin).unpause();

            await expect(executor.connect(admin).setWhitelistedSelectors([router, router], [swapFunctionSelector], [true])).revertedWithCustomError(executor, "NonMatchingLength").withArgs(2,1,1);
            await expect(executor.connect(admin).setWhitelistedSelectors([router], [swapFunctionSelector, swapFunctionSelector], [true])).revertedWithCustomError(executor, "NonMatchingLength").withArgs(1,2,1);
            await expect(executor.connect(admin).setWhitelistedSelectors([router], [swapFunctionSelector], [true, true])).revertedWithCustomError(executor, "NonMatchingLength").withArgs(1,1,2);

            await executor.connect(admin).setWhitelistedSelectors([router], [swapFunctionSelector], [true]);

            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "LowBalance").withArgs(user, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", ethers.parseEther("10000") + BigInt(100), ethers.parseEther("10000") + BigInt(101));

            let routerFactory = await ethers.getContractFactory("MockRouter");
            let anotherRouterFunction = routerFactory.interface.getFunction("anotherFunction");

            swapData.functionSignature = anotherRouterFunction.format();
            swapData.executionCalldata = abiCoder.encode(["bool"], [true]);

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 0, deadline));
            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "InvalidFunctionCall").withArgs(router, anotherRouterFunction.selector);

            await executor.connect(admin).setWhitelistedSelectors([router], [anotherRouterFunction.selector], [true]);

            await expect(executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "SwapFailed").withArgs(false, routerFactory.interface.getError("Reverted").selector);

            swapData = {
                executionContract: router.target,
                functionSignature: swapFunctionSignature,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token1.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", user.address, 500, 100]),
                outputToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
                receiver: user.address,
                inputAmount: 1000,
                minAmountOut: 50
            }

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token1, 0, deadline));
            let tx = executor.connect(relayer).executeSwap(user, token1, permitInfo, swapData, feeSwapData, deadline, signature);
            await expect(tx).changeTokenBalances(token1, [user, executor, router], [-600, 50, 550]);
            await expect(tx).changeEtherBalances([user, admin, router], [100, 10, -110]);
            expect(await executor.userNonce(user)).equal(1);

            permitDomain.verifyingContract = token2.target;
            permitInfo = {
                required: false,
                value: 0,
                deadline: 0,
                v: 0,
                r: ethers.ZeroHash,
                s: ethers.ZeroHash
            }

            swapData = {
                executionContract: router.target,
                functionSignature: swapFunctionSignature,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token2.target, token1.target, user.address, 100, 100]),
                outputToken: token1.target,
                receiver: user.address,
                inputAmount: 100,
                minAmountOut: 100
            }

            feeSwapData = {
                executionContract: router.target,
                functionSelector: swapFunctionSelector,
                executionCalldata: abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token2.target, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", admin.address, 100, 10]),
                inputAmount: 100
            }

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token2, 1, deadline));
            await token2.connect(user).approve(executor, 200);
            await expect(executor.connect(relayer).executeSwap(user, token2, permitInfo, swapData, feeSwapData, deadline, signature)).revertedWithCustomError(executor, "LowBalance").withArgs(executor, token2, 80, 100);

            swapData.executionCalldata = abiCoder.encode(["address", "address", "address", "uint256", "uint256"], [token2.target, token1.target, user.address, 80, 100]);

            signature = await user.signTypedData(domain, types, getSignatureValuesFromData(swapData, feeSwapData, token2, 1, deadline));
            tx = executor.connect(relayer).executeSwap(user, token2, permitInfo, swapData, feeSwapData, deadline, signature);
            await expect(tx).changeTokenBalances(token2, [user, executor, router], [-200, 0, 162]);
            await expect(tx).changeTokenBalances(token1, [user, router], [100, -100]);
            await expect(tx).changeEtherBalances([admin, router], [10, -10]);
            expect(await executor.userNonce(user)).equal(2);

            await expect(executor.connect(admin).getToken(token1, admin, 10)).changeTokenBalances(token1, [executor, admin], [-10, 10]);
        })
    })
})

function getSignatureValuesFromData(swapData, feeSwapData, token, nonce, deadline) {
    return {
        token: token.target,
        swapData,
        feeAmount: feeSwapData.inputAmount,
        nonce,
        deadline
    }
}